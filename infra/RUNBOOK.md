# Production Runbook — graph-service on AWS

This document is the operator's guide to deploying, redeploying, and recovering the production environment for `liner-notes`. The architecture is summarized in the root [CLAUDE.md](../CLAUDE.md) under "Deployment Overview"; this file covers the _operations_.

**Target architecture:**

- `graph-service` running in a single-node k3s cluster on an EC2 t3.micro
- Neo4j AuraDB Free as the graph database
- AWS Secrets Manager holds runtime credentials, synced into the cluster by [External Secrets Operator](https://external-secrets.io/) (ESO)
- AWS ECR holds the container image
- The pod is exposed via a NodePort `Service` on `30080`; the EC2 security group opens that port

---

## Prerequisites

On your laptop:

- AWS CLI configured with credentials that can manage VPC / EC2 / IAM / ECR / Secrets Manager
- `terraform` (>= 1.5), `kubectl` (>= 1.30), `docker`, `helm` (>= 3.10)
- The Aura connection details — `NEO4J_URI` (`neo4j+s://…`), `NEO4J_USER`, `NEO4J_PASSWORD` — from the Aura console
- Discogs API token and your Discogs username
- A generated `ADMIN_TOKEN` (any high-entropy random string)

---

## First-time deploy

### 1. Apply Terraform

```bash
cd infra/terraform
terraform init
terraform apply
```

After apply, capture the outputs:

```bash
terraform output
```

You'll need `ecr_repository_url`, `ec2_instance_id`, `ec2_public_dns`, and `service_url` below.

### 2. Populate the Secrets Manager value

Terraform created the secret container but **not** the value. Populate it once:

```bash
aws secretsmanager put-secret-value \
  --secret-id liner-notes/graph-service/prod \
  --secret-string '{
    "NEO4J_URI": "neo4j+s://<your-aura-id>.databases.neo4j.io",
    "NEO4J_USER": "neo4j",
    "NEO4J_PASSWORD": "<your-aura-password>",
    "DISCOGS_USERNAME": "<your-discogs-username>",
    "DISCOGS_TOKEN": "<your-discogs-token>",
    "DISCOGS_USER_AGENT": "liner-notes/1.0 +https://github.com/macamp0328/liner-notes",
    "MUSICBRAINZ_USER_AGENT": "liner-notes/1.0 +https://github.com/macamp0328/liner-notes",
    "ADMIN_TOKEN": "<generated-random-token>"
  }'
```

- **`MUSICBRAINZ_USER_AGENT`** is required by the MusicBrainz / VIAF / Wikidata enrichment paths (`/api/v1/admin/nationality/enrich`, `/api/v1/admin/track-musicbrainz/enrich`, and friends). Without it, those endpoints return 503.
- Add `GENIUS_TOKEN` to the JSON for lyrics enrichment.
- `ACOUSTICBRAINZ_USER_AGENT` is optional and defaults to `liner-notes/1.0`.

> **Why the value isn't in Terraform:** keeping the password out of state means it isn't readable from `terraform.tfstate` (which may end up in S3, a Git repo, or a CI cache later). Rotation is then a `put-secret-value` away — no Terraform apply needed.

### 3. Build and push the first image

```bash
ECR_URL=$(terraform output -raw ecr_repository_url)
REGION=$(terraform output -raw aws_region 2>/dev/null || echo us-east-1)
TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_URL"

# Build context is the repo root.
docker build \
  -f services/graph-service/Dockerfile \
  -t "$ECR_URL:$TAG" \
  ../..

docker push "$ECR_URL:$TAG"
```

### 4. Connect to the k3s node

The instance has the `AmazonSSMManagedInstanceCore` role attached — use Session Manager rather than SSH:

```bash
aws ssm start-session --target $(terraform output -raw ec2_instance_id)
```

If you preferred SSH (`var.ssh_key_name` + `var.allow_ssh_cidr` set in Terraform), use the public DNS instead.

### 5. Install External Secrets Operator

Once inside the node:

```bash
# k3s gives ec2-user kubectl access via /home/ec2-user/.kube/config (user_data step).
sudo su - ec2-user

helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true

# Wait for the webhook to be ready, otherwise the ClusterSecretStore apply
# below will fail with a webhook timeout.
kubectl rollout status deployment/external-secrets-webhook -n external-secrets
```

### 6. Bootstrap the ECR pull secret

Plain k3s/containerd does not use the EC2 instance role for image pulls. The repo ships a CronJob (`ecr-pull-secret-refresher`) that mints a fresh 12h ECR token every 6 hours and writes it to `Secret/ecr-pull-secret`, which the Deployment references via `imagePullSecrets`. The CronJob can't run until the manifests are applied, so for the first pull we create the secret by hand:

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl -n liner-notes create secret docker-registry ecr-pull-secret \
  --docker-server="$ECR_URL" \
  --docker-username=AWS \
  --docker-password="$(aws ecr get-login-password --region "$REGION")"
```

After the manifests are applied (next step), the CronJob takes over and the secret stays fresh on its own.

### 7. Apply the application manifests

Copy the repo onto the node (`git clone`), or apply from your laptop with `KUBECONFIG` pointing at the k3s kubeconfig.

**Before applying, do two one-time edits to the checked-in manifests:**

1. **If you applied Terraform with a non-default region** (anything other than `us-east-1`), update two values to match — otherwise ESO will look in the wrong region:

   ```bash
   sed -i.bak "s/us-east-1/$REGION/g" \
     infra/k8s/graph-service/external-secret.yaml \
     infra/k8s/graph-service/ecr-pull-secret-refresher.yaml
   ```

2. **Set the CronJob's `ECR_REGISTRY` env to your real registry hostname** so the refresh job writes a `dockerconfigjson` with the right server:
   ```bash
   sed -i.bak "s|value: REPLACE_ME|value: $ECR_URL|" \
     infra/k8s/graph-service/ecr-pull-secret-refresher.yaml
   ```

Then apply:

```bash
# Edit infra/k8s/graph-service/deployment.yaml to set the image tag to $ECR_URL:$TAG
# (or use `kubectl set image` after the initial apply — see "Redeploy procedure").

kubectl apply -k infra/k8s/graph-service/
```

### 8. Verify

```bash
kubectl -n liner-notes get pods
kubectl -n liner-notes get externalsecret graph-service-secrets
kubectl -n liner-notes describe externalsecret graph-service-secrets  # should show "SecretSynced"

# From your laptop:
curl http://<ec2_public_dns>:30080/api/v1/health
# Expect: {"status":"ok","neo4j":"connected"}
```

The empty-graph auto-ingest fires on first boot — `kubectl -n liner-notes logs deployment/graph-service -f` to watch it. Expect ~4 minutes for ~6,150 nodes and ~14,297 relationships.

---

## Redeploy procedure

```bash
TAG=$(git rev-parse --short HEAD)
ECR_URL=<from terraform output>

docker build -f services/graph-service/Dockerfile -t "$ECR_URL:$TAG" .
docker push "$ECR_URL:$TAG"

kubectl -n liner-notes set image \
  deployment/graph-service \
  graph-service="$ECR_URL:$TAG"

kubectl -n liner-notes rollout status deployment/graph-service
```

The deployment uses `strategy: Recreate` — there will be ~30 seconds of downtime while the old pod terminates and the new one starts. Acceptable for a personal-project prod; a multi-AZ HA setup is out of scope.

---

## Resuming a paused Aura instance

AuraDB Free auto-pauses after **72 hours of inactivity**. Traffic does **not** auto-resume a paused instance.

1. Sign in to [console.neo4j.io](https://console.neo4j.io)
2. Open the project, click the paused instance, click **Resume**
3. Wait ~30 seconds for the instance to come back online
4. Restart graph-service pods so the driver reconnects cleanly:
   ```bash
   kubectl -n liner-notes rollout restart deployment/graph-service
   ```

A scheduled keep-warm ping is tracked in [#103](https://github.com/macamp0328/liner-notes/issues/103).

---

## Where to look when things break

| Symptom                                                         | First thing to check                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pod stuck in `CrashLoopBackOff` on first deploy                 | `kubectl -n liner-notes describe externalsecret graph-service-secrets` — if status is `SecretSyncedError`, the AWS secret value hasn't been populated (step 2) or the instance role is missing `secretsmanager:GetSecretValue`.       |
| Pod restarts every ~minute                                      | `kubectl -n liner-notes logs deployment/graph-service` — usually a Neo4j connectivity issue: Aura paused, wrong `NEO4J_URI`, or a transient network blip.                                                                             |
| `503` from `/api/v1/health` with `neo4j: disconnected`          | Aura paused — see "Resuming a paused Aura instance".                                                                                                                                                                                  |
| `ExternalSecret` perpetually `SecretSyncedError: Access Denied` | EC2 instance role missing Secrets Manager read; verify `aws_iam_role_policy.secrets_read` in `infra/terraform/iam.tf` matches the secret ARN.                                                                                         |
| `ImagePullBackOff`                                              | `kubectl -n liner-notes get secret ecr-pull-secret` — if missing or older than 12h, re-run the bootstrap from step 6 and `kubectl -n liner-notes create job --from=cronjob/ecr-pull-secret-refresher refresh-now` to force a refresh. |
| Health endpoint unreachable from the internet                   | EC2 security group: `aws_vpc_security_group_ingress_rule.app_nodeport` must allow your IP on port 30080.                                                                                                                              |
| k3s itself broken                                               | `sudo journalctl -u k3s -n 200` on the node.                                                                                                                                                                                          |

---

## Tear-down

```bash
cd infra/terraform
terraform destroy
```

This deletes the EC2 instance, VPC, ECR repository (and all images — the repo is created with `force_delete = true`), IAM roles, and the Secrets Manager secret container. The Aura instance is **not** managed by Terraform — leave it alone if you want to keep the graph data.
