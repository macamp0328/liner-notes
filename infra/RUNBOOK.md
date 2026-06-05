# Production Runbook — graph-service on AWS

This is the operator's guide to standing up, redeploying, and recovering the production environment for `liner-notes`. The architecture is summarized in the root [CLAUDE.md](../CLAUDE.md) under "Deployment Overview"; this file covers the _operations_.

- [Architecture at a glance](#architecture-at-a-glance)
- [Prerequisites](#prerequisites)
- [First-time deploy — step by step](#first-time-deploy--step-by-step)
- [Observability — fluent-bit and alarms](#observability--fluent-bit-and-alarms)
- [Redeploy procedure](#redeploy-procedure)
- [CD — IAM bootstrap](#cd--iam-bootstrap)
- [CD — cluster bootstrap](#cd--cluster-bootstrap)
- [CD — workflow setup](#cd--workflow-setup)
- [Full reload from scratch](#full-reload-from-scratch)
- [Instance power switch — scale-to-zero](#instance-power-switch--scale-to-zero)
- [Resuming a paused Aura instance](#resuming-a-paused-aura-instance)
- [Where to look when things break](#where-to-look-when-things-break)
- [Tear-down](#tear-down)

---

## Architecture at a glance

<!-- diagrams:request-flow:start -->

```mermaid
flowchart LR
  user([Your laptop / browser]):::ext

  subgraph aws["AWS account · region us-east-1"]
    direction TB

    subgraph vpc["VPC 10.0.0.0/16 · public subnet · SG opens :30080"]
      direction TB

      subgraph ec2["EC2 t3.small · AL2023 · k3s single-node"]
        direction TB

        subgraph ns["k8s namespace: liner-notes"]
          direction TB
          svc[/"Service · NodePort 30080"/]
          pod["Pod · graph-service"]
          k8s_secret[("Secret · graph-service-secrets")]
          k8s_pull[("Secret · ecr-pull-secret<br/>(dockerconfigjson)")]
          cron["CronJob · ecr-pull-secret-refresher<br/>every 6h"]
          svc --> pod
          k8s_secret -.envFrom.-> pod
          k8s_pull -.imagePullSecret.-> pod
          cron -- "writes refreshed token" --> k8s_pull
        end

        subgraph eso["k8s namespace: external-secrets"]
          eso_op["External Secrets Operator"]
        end

        eso_op -- "syncs every 1h" --> k8s_secret
      end
    end

    subgraph account["AWS account scope (outside the VPC)"]
      direction TB
      ecr["ECR · liner-notes/graph-service<br/>(last 10 tagged images)"]
      sm["Secrets Manager<br/>liner-notes/graph-service/prod"]
      iam["EC2 IAM role · ec2_k3s<br/>ECR read · SM read · SSM"]
    end
    iam -.attached.-> ec2
  end

  subgraph external["External services"]
    direction TB
    aura[("Neo4j AuraDB Free · GCP<br/>neo4j+s:// · :7687")]:::ext
    discogs[("Discogs API<br/>https · 60 req/min")]:::ext
  end

  user -- "http :30080 (NodePort)" --> svc
  pod == "Cypher · neo4j+s://" ==> aura
  pod -.ingest.-> discogs
  cron == "ecr get-login-password<br/>(IMDS → instance role)" ==> ecr
  eso_op == "GetSecretValue<br/>(IMDS → instance role)" ==> sm
  pod == "image pull<br/>(via dockerconfigjson)" ==> ecr

  subgraph legend["Edge legend &nbsp;·&nbsp; color = flow category"]
    direction LR
    lr1[src]:::legendNode -- "user request" --> lr2[sink]:::legendNode
    ld1[src]:::legendNode == "heavy data path" ==> ld2[sink]:::legendNode
    lc1[src]:::legendNode -. "secret sync / control plane" .-> lc2[sink]:::legendNode
    le1[src]:::legendNode -. "external egress" .-> le2[sink]:::legendNode
  end

  %% Edge indices follow declaration order across the entire file.
  %% Main edges (0–11):
  %%   0  svc --> pod                          (request)
  %%   1  k8s_secret -.envFrom.-> pod          (mount, gray default)
  %%   2  k8s_pull -.imagePullSecret.-> pod    (mount, gray default)
  %%   3  cron -- "writes refreshed token" --> k8s_pull   (secret sync)
  %%   4  eso_op -- "syncs every 1h" --> k8s_secret       (secret sync)
  %%   5  iam -.attached.-> ec2                (attachment, gray default)
  %%   6  user --> svc                         (request)
  %%   7  pod ==> aura                         (data path)
  %%   8  pod -.ingest.-> discogs              (external egress)
  %%   9  cron ==> ecr                         (secret sync — image-pull token)
  %%  10  eso_op ==> sm                        (secret sync)
  %%  11  pod ==> ecr                          (data path — image pull)
  %% Legend edges (12–15):
  %%  12  lr1 --> lr2                          (request)
  %%  13  ld1 ==> ld2                          (data path)
  %%  14  lc1 -.-> lc2                         (secret sync)
  %%  15  le1 -.-> le2                         (external egress)
  linkStyle 0,6,12 stroke:#0f172a,stroke-width:2px
  linkStyle 7,11,13 stroke:#1d4ed8,stroke-width:2.5px
  linkStyle 3,4,9,10,14 stroke:#7c3aed,stroke-width:1.8px
  linkStyle 8,15 stroke:#15803d,stroke-width:1.8px

  classDef ext fill:#f4f4f4,stroke:#999,stroke-dasharray:5 3
  classDef legendNode fill:#ffffff,stroke:#cbd5e1,color:#475569
```

<!-- diagrams:request-flow:end -->

> **Source of truth:** [`infra/diagrams/request-flow.mmd`](diagrams/request-flow.mmd). Regenerate with `pnpm diagrams:generate` after editing. A full Terraform resource graph (auto-generated) lives at [`diagrams/resource-graph.svg`](diagrams/resource-graph.svg); per-file Mermaid diagrams are under [`diagrams/per-file/`](diagrams/per-file/).

**Key flows:**

- **Secrets**: AWS Secrets Manager → External Secrets Operator → k8s `Secret` → pod env. ESO authenticates via the EC2 instance role through IMDS — no static AWS keys live in the cluster.
- **Image pulls**: a CronJob mints a fresh 12h ECR auth token every 6h using the same instance role, writes it into `Secret/ecr-pull-secret`, and the Deployment references it via `imagePullSecrets`. Plain k3s/containerd doesn't speak IAM directly, so this k8s-native loop fills the gap.
- **Ingress**: NodePort `:30080`, opened to the world (or to a narrowed CIDR) by the EC2 security group. Read endpoints are public; mutating endpoints require `ADMIN_TOKEN`.
- **Graph data**: Aura Free in GCP. Cross-cloud Cypher latency is ~tens of ms — acceptable for this workload.

---

## Prerequisites

### Tooling on your laptop

All mandatory. Install via Homebrew on macOS (or your package manager of choice):

```bash
brew install mise              # runtime version manager — pins the toolchain per .mise.toml below
brew install kustomize         # k8s/kubectl bundles a `kustomize` subcommand but not `kustomize edit`
brew install jq                # for validating the Secrets Manager JSON before submitting
brew install --cask session-manager-plugin   # required for every `aws ssm` command
```

Then from the repo root, install the mise-managed tools (`terraform`, `kubectl`, `helm`, `gh`, `aws-cli`, `node`, `pnpm`):

```bash
mise install
```

| Tool                     | Why                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `aws` CLI                | Manage VPC / EC2 / IAM / ECR / Secrets Manager / SSM                                     |
| `terraform`              | `>= 1.5` — pinned in `.mise.toml`                                                        |
| `kubectl`                | `>= 1.30` — pinned in `.mise.toml`                                                       |
| `kustomize`              | Standalone — `kubectl kustomize` doesn't include the `edit` subcommand the runbook needs |
| `docker`                 | Build the container image (Docker Desktop on macOS)                                      |
| `helm`                   | `>= 3.10` — one-time install of External Secrets Operator                                |
| `jq`                     | Validate the Secrets Manager JSON before pushing it                                      |
| `session-manager-plugin` | Required by every `aws ssm start-session` invocation                                     |
| `mise`                   | Pins the toolchain versions in `.mise.toml`                                              |

### AWS credentials

The runbook assumes a non-root IAM user (`liner-notes-cli` in our setup) with the following — no AWS-managed policies, all permissions come from this repo:

- **Customer-managed policy** from [`infra/iam/operator-iam-policy.json`](iam/operator-iam-policy.json) — Terraform-managed IAM roles, CloudWatch logs + alarms, SNS topic + subscription, Route 53 health checks
- **Customer-managed policy** from [`infra/iam/operator-deploy-policy.json`](iam/operator-deploy-policy.json) — VPC, EC2, EIP, ECR, Secrets Manager (everything `terraform apply` plus the runbook's `docker push` / `put-secret-value` / instance-resize flows touch)
- **Inline policy** from [`infra/iam/operator-ssm-policy.json`](iam/operator-ssm-policy.json) — SSM Session Manager

See [`infra/iam/README.md`](iam/README.md) for the one-time attach procedure. **Do this before Step 1** or `terraform apply` and the `aws ssm` calls will fail with `AccessDenied`.

### Credentials to have on hand

- **Aura** — `NEO4J_URI` (`neo4j+s://…databases.neo4j.io`), `NEO4J_USER`, `NEO4J_PASSWORD` from [console.neo4j.io](https://console.neo4j.io).
- **Discogs** — your username + a personal access token.
- A random **`ADMIN_TOKEN`** — generate with `openssl rand -hex 32`.

---

## First-time deploy — step by step

> **Where commands run:** every step in this section runs on **your laptop** except a few minutes inside Step 5, which open an interactive SSM session on the EC2 node. Step 4 opens a Session Manager port-forward in a second terminal that stays running for Steps 6–8.
>
> **Shell variables carry between steps.** Set `REGION`, `ECR_URL`, `ECR_REGISTRY`, `INSTANCE_ID`, `PUBLIC_DNS`, `SERVICE_URL`, `TAG`, `KUBECONFIG` once in Step 1 / Step 3 / Step 4 — keep the same terminal open or re-export them.

### Step 1 — Apply Terraform

From the repo root:

```bash
cd infra/terraform
terraform init
AWS_PROFILE=root terraform apply         # FIRST apply: admin profile — type `yes` to confirm
```

> **The first apply needs the admin `root` profile, later applies don't.** The root module includes the **account-wide** GitHub Actions OIDC provider (`aws_iam_openid_connect_provider.github` — see [CD — IAM bootstrap](#cd--iam-bootstrap)). Creating it needs `iam:CreateOpenIDConnectProvider`, which the scoped operator (`default`/`liner-notes-cli`) deliberately doesn't have, so this very first `terraform apply` must run as `AWS_PROFILE=root`. Every **subsequent** apply can use the operator `default` profile: [`operator-iam-policy.json`](iam/operator-iam-policy.json) grants read-only `iam:GetOpenIDConnectProvider` + `iam:ListOpenIDConnectProviderTags` (the provider runs with `default_tags`, so Terraform reads its tags on refresh too), which is what Terraform needs to _refresh_ the existing provider on later runs. (Without those read grants, a plain operator apply would fail on refresh with `AccessDenied` — see the iam README.) If your account already has a GitHub OIDC provider, run the [CD — IAM bootstrap Step 1](#step-1--check-for-an-existing-oidc-provider) existence check first and switch `cicd.tf` to the data-source form before applying.

Capture the outputs for later steps:

```bash
export REGION=$(terraform output -raw aws_region)
export ECR_URL=$(terraform output -raw ecr_repository_url)
export ECR_REGISTRY="${ECR_URL%%/*}"          # registry hostname only (strip the repo path)
export INSTANCE_ID=$(terraform output -raw ec2_instance_id)
export PUBLIC_DNS=$(terraform output -raw ec2_public_dns)
export SERVICE_URL=$(terraform output -raw service_url)

# Sanity — every line should print non-empty
for v in REGION ECR_URL ECR_REGISTRY INSTANCE_ID PUBLIC_DNS SERVICE_URL; do
  printf "%-14s = %s\n" "$v" "$(eval echo \$$v)"
done

cd "$(git rev-parse --show-toplevel)"
```

**Expected:** ~3 minutes for the apply. EC2 user_data continues installing k3s + helm on the node for another ~2 minutes after the instance comes up.

> **EIP IP-swap on first apply.** `aws_eip.k3s` (added in [#125](https://github.com/macamp0328/liner-notes/pull/125)) replaces the instance's auto-assigned public IP with a stable Elastic IP. On the very first `terraform apply` against an existing instance, the public IP changes — re-fetch `PUBLIC_DNS` / `SERVICE_URL` (the export block above does this), and refresh any browser bookmarks pointed at the old address. After that, the EIP is permanent across stop/start cycles.

### Step 2 — Populate AWS Secrets Manager

Terraform created the secret _container_ but **not** the value. Populate it once. `MUSICBRAINZ_USER_AGENT` is mandatory — without it the MusicBrainz / VIAF / Wikidata enrichment endpoints return 503.

Build the JSON in a shell variable so you can validate it with `jq` before sending — malformed JSON here is by far the most common cause of `ExternalSecret SecretSyncedError` later:

```bash
SECRET_JSON='{
  "NEO4J_URI":            "neo4j+s://<your-aura-id>.databases.neo4j.io",
  "NEO4J_USER":           "neo4j",
  "NEO4J_PASSWORD":       "<your-aura-password>",
  "DISCOGS_USERNAME":     "<your-discogs-username>",
  "DISCOGS_TOKEN":        "<your-discogs-token>",
  "DISCOGS_USER_AGENT":   "liner-notes/1.0 +https://github.com/macamp0328/liner-notes",
  "MUSICBRAINZ_USER_AGENT": "liner-notes/1.0 +https://github.com/macamp0328/liner-notes",
  "ADMIN_TOKEN":          "<your-generated-random-token>"
}'

# Validate first — if jq accepts it, AWS will too
echo "$SECRET_JSON" | jq .

# Push the value to AWS Secrets Manager
aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id liner-notes/graph-service/prod \
  --secret-string "$SECRET_JSON"
```

Add `GENIUS_TOKEN` to the JSON for lyrics enrichment; `ACOUSTICBRAINZ_USER_AGENT` is optional.

> **Why this isn't in Terraform:** keeping the value out of state means the Aura password isn't readable from `terraform.tfstate`, and rotation is one CLI call away — no Terraform run needed.

### Step 3 — Build and push the first image

```bash
export TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_URL"

docker buildx build \
  --platform linux/amd64 \
  -f services/graph-service/Dockerfile \
  -t "$ECR_URL:$TAG" \
  --push \
  .
```

**`--platform linux/amd64` is mandatory if you're on an Apple Silicon Mac.** `docker build` without the flag defaults to your host architecture (`linux/arm64` on M1/M2/M3/M4), and the EC2 instance is `linux/amd64` — the pod will fail with `no match for platform in manifest: not found` if you skip this.

`buildx ... --push` builds and pushes in one shot. Expected: ~2–4 minutes for a clean build, ~30s on cached re-runs.

### Step 4 — Get a kubeconfig pointed at the k3s API via SSM port-forward

The k3s API server listens on `:6443`. We don't open that port in the security group — instead we tunnel through SSM, which keeps the API private and avoids the TLS-SAN problem (k3s only signs its API cert for `127.0.0.1` / the node's local IPs unless told otherwise, so connecting to `$PUBLIC_DNS:6443` would fail certificate verification).

**4a. Grab the kubeconfig:**

```bash
mkdir -p ~/.kube
aws ssm start-session --region "$REGION" --target "$INSTANCE_ID" \
  --document-name AWS-StartInteractiveCommand \
  --parameters 'command=["sudo cat /etc/rancher/k3s/k3s.yaml"]' \
  > ~/.kube/liner-notes-prod.yaml

# Trim the SSM banner lines if present (first line "Starting session..." and
# trailing "Exiting session..."). Open the file in your editor and ensure the
# first non-empty line is `apiVersion: v1` and the last is the user's
# `client-key-data:` value.

export KUBECONFIG=~/.kube/liner-notes-prod.yaml
```

The kubeconfig points at `https://127.0.0.1:6443` — leave it that way. The k3s API cert is valid for `127.0.0.1`, and the port-forward below makes that local address reach the node.

**4b. Open a port-forward in a separate terminal** and leave it running for the rest of the deploy:

```bash
# In a NEW terminal — keep this open for Steps 6–8.
aws ssm start-session --region "$REGION" --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}'
```

**4c. Sanity-check the tunnel:**

```bash
nc -zv 127.0.0.1 6443                    # "succeeded"
curl -sk https://127.0.0.1:6443/livez    # "ok" (401 if you've never auth'd — also fine, means TLS is good)
```

### Step 5 — Install External Secrets Operator (on the node, not via the tunnel)

`helm install` fires ~8 concurrent API calls during install. The SSM port-forward can't carry that level of parallelism reliably — you'll see `TLS handshake timeout` and `client connection lost` errors. Solution: install helm on the node itself, where the k3s API is local with zero network indirection.

Open an **interactive** SSM session (separate from the port-forward; the default per-instance limit is 2 concurrent sessions, both fit):

```bash
aws ssm start-session --region "$REGION" --target "$INSTANCE_ID"
```

You'll get a `sh-5.2$` prompt as `ssm-user`. Inside the session:

```bash
sudo -i -u ec2-user                              # switch to the user that owns ~/.kube/config
export KUBECONFIG=~/.kube/config

# Sanity — should print one Ready node
kubectl get nodes

# Install ESO directly on the node — fast and reliable
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --wait --timeout 5m

# Verify
kubectl get pods -n external-secrets
```

**Expected:** ~1 minute. Three pods Running `1/1`: `external-secrets`, `external-secrets-webhook`, `external-secrets-cert-controller`. Then `exit` twice (once to leave `ec2-user`, once to leave the SSM session) — you're back on your laptop.

### Step 6 — Bootstrap the ECR pull secret

Run from your laptop with `KUBECONFIG` set and the Step 4b port-forward still running. The CronJob can't run before its own manifest exists, so we create the first pull secret by hand. After this, the CronJob takes over and refreshes it every 6 hours.

`ECR_REGISTRY` was exported in Step 1 — `docker-server` wants the registry hostname only, not the repo path:

```bash
kubectl apply -f infra/k8s/namespace.yaml

kubectl -n liner-notes create secret docker-registry ecr-pull-secret \
  --docker-server="$ECR_REGISTRY" \
  --docker-username=AWS \
  --docker-password="$(aws ecr get-login-password --region "$REGION")"

kubectl get secret -n liner-notes ecr-pull-secret    # should print "ecr-pull-secret  kubernetes.io/dockerconfigjson"
```

### Step 7 — Apply the application manifests

Still on your laptop, port-forward still running. One one-time edit to point the Deployment at your image (plus a conditional region retarget), then apply with kustomize:

```bash
cd infra/k8s/graph-service

# 7a. If you applied Terraform with a non-default region, retarget the
#     ClusterSecretStore and the CronJob's AWS_REGION to match. The CronJob
#     derives the ECR hostname itself from AWS_REGION — nothing else to set.
if [ "$REGION" != "us-east-1" ]; then
  sed -i.bak "s/us-east-1/$REGION/g" external-secret.yaml ecr-pull-secret-refresher.yaml
fi

# 7b. Point the Deployment at the image you just pushed.
kustomize edit set image "graph-service-image=$ECR_URL:$TAG"

# 7c. Apply everything: ServiceAccount/Role/RoleBinding/CronJob/Service/Deployment/ClusterSecretStore/ExternalSecret.
kubectl apply -k .

cd "$(git rev-parse --show-toplevel)"
```

**Expected:** ~8 lines of `<resource> created`. The pod takes ~30s to pull the image and start.

> **About the working-tree changes:** the `sed` and `kustomize edit` commands modify checked-in files. They're deploy-time overrides — **don't commit them**. After the deploy succeeds, restore the originals:
>
> ```bash
> git restore infra/k8s/graph-service/{external-secret,ecr-pull-secret-refresher,kustomization}.yaml
> rm -f infra/k8s/graph-service/*.bak
> ```

### Step 8 — Verify

Run from your laptop. `kubectl` calls need the Step 4b port-forward; `curl` reaches the service over the public internet on `:30080` (different port from the k3s API).

```bash
# Pod is Running and Ready
kubectl -n liner-notes get pods

# ExternalSecret status is "SecretSynced"
kubectl -n liner-notes get externalsecret graph-service-secrets

# Health endpoint returns 200 from the public DNS
curl -sS "$SERVICE_URL/api/v1/health"
# Expected: {"status":"ok","neo4j":"connected"}
```

The empty-graph auto-ingest fires on first boot:

```bash
kubectl -n liner-notes logs deployment/graph-service -f
```

**Expected:** progress logs starting with `Graph is empty — starting Discogs ingestion in background`. For the project's ~30-record reference collection that ends up around ~6,150 nodes and ~14,297 relationships, the base ingest takes ~4 minutes. The pipeline then runs `lyrics`, `master-data`, and `artist-profiles` enrichments in the background — watch for `Ingestion complete` followed by per-enrichment progress lines.

Five further enrichments (`nationality`, `mb-release-events`, `track-musicbrainz`, `track-acousticbrainz`, `track-deezer`) are **not** part of `runIngestion` because they'd lengthen the cold-start path from ~4 min to ~45 min. They have to be triggered manually — see [Step 8b](#step-8b--first-deploy-enrichment-bootstrap).

Spot-check the real data:

```bash
curl -sS "$SERVICE_URL/api/v1/releases?limit=3" | jq .
```

---

### Step 8b — First-deploy enrichment bootstrap

Run from your laptop, inside a fresh clone of the repo. Triggers the five manual-only enrichment passes in dependency order — `mb-release-events` → `track-musicbrainz` → (`track-acousticbrainz` + `track-deezer` in parallel) → `nationality`.

```bash
# One-off env (or drop these into a gitignored .env.local at the repo root)
export GRAPH_SERVICE_URL="$SERVICE_URL"
export ADMIN_TOKEN="$(aws secretsmanager get-secret-value \
  --secret-id liner-notes/graph-service/prod \
  --query SecretString --output text | jq -r '.ADMIN_TOKEN')"

# Snapshot the current state of every enrichment (read-only, ~1s)
pnpm status:nationality
pnpm status:mb-release-events
pnpm status:track-musicbrainz
pnpm status:track-acousticbrainz
pnpm status:track-deezer

# Run all four manual stages in dependency order
pnpm enrich:bootstrap
```

**Expected runtime** for the ~30-record reference collection:

| Stage                  | Duration | Why                                                 |
| ---------------------- | -------- | --------------------------------------------------- |
| `mb-release-events`    | ~5 min   | One MusicBrainz call per master (rate-limit 1 rps). |
| `track-musicbrainz`    | ~30 min  | One MusicBrainz call per track for ISRC matching.   |
| `track-acousticbrainz` | ~5 min   | AcousticBrainz; runs in parallel with deezer.       |
| `track-deezer`         | ~5 min   | Deezer; runs in parallel with acousticbrainz.       |
| `nationality`          | ~5 min   | VIAF + Wikidata lookups per person.                 |

**Total**: ~45 minutes wall-clock for a fresh collection. Keep the terminal open — the HTTP requests block until each stage completes, and `curl -fsS` will exit non-zero if any stage fails so the `&&`-chained sequence stops cleanly.

Individual stages can be run on their own (`pnpm enrich:nationality`, `pnpm enrich:track-deezer`, etc.) when only one needs a re-run.

After the run, spot-check that the new properties populated:

```bash
curl -sS "$SERVICE_URL/api/v1/releases?limit=1" | jq '.data[0].tracks[0] | {position, isrc, tempo, deezerBpm}'
# Expected: isrc, tempo, deezerBpm all non-null on a typical track.
```

---

## Observability — fluent-bit and alarms

`terraform apply` (Step 1) created the supporting AWS resources for observability: a CloudWatch Log Group (`/liner-notes/graph-service`), an SNS topic with an email subscription, a Route 53 health check probing `/api/v1/health`, seven alarms, and a `liner-notes-graph-service` dashboard surfacing all of the above in one view.

| Alarm                           | Fires on                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `liner-notes-pod-restarts`      | Kubelet logs `Liveness probe failed` or `CrashLoopBackOff` within 5 min.     |
| `liner-notes-health-check`      | Route 53 external probe of `/api/v1/health` fails for 2 consecutive minutes. |
| `liner-notes-ec2-status-check`  | AWS EC2 system or instance status check fails for 2 consecutive minutes.     |
| `liner-notes-error-log-lines`   | More than 5 pino ERROR-level (`level >= 50`) log lines in 5 min.             |
| `liner-notes-http-5xx`          | One or more 5xx responses logged by Fastify in 5 min.                        |
| `liner-notes-neo4j-disconnects` | `ServiceUnavailable` or `SessionExpired` appears in the log group in 5 min.  |
| `liner-notes-billing`           | AWS estimated charges exceed $20 (USD) for the current billing period.       |

This section covers the three manual follow-ups: confirming the SNS subscription, enabling AWS account-level billing alerts, and installing the in-cluster fluent-bit daemonset that actually writes logs to the log group.

The unified view is at `terraform output -raw dashboard_url`, organized into labelled sections: an **alarm strip**; **At a glance** single-value tiles (requests, 5xx, errors, Neo4j disconnects); **Health & infrastructure** (Route 53 probe, EC2 CPU/network/status, pod restarts, Neo4j disconnects); **Traffic & latency** (response-latency percentiles, HTTP status mix, and real non-probe request volume); **Errors & diagnostics** (the ERROR-rate metric alongside the actual recent-error text, a grouped top-message summary, and external-API rate-limit backoffs); **Ingestion & enrichment activity** (log throughput plus a pipeline run-history table); and **Collection over time** (graph size and enrichment-coverage % trended from the periodic `stats snapshot` log line graph-service emits). It opens on the last 3 days by default. The Traffic, Errors, Ingestion, and Collection panels are CloudWatch Logs Insights queries over the structured logs fluent-bit already ships — they add no new custom metrics, so no metric cost.

### Step 9 — Confirm the SNS subscription

After `terraform apply`, AWS sends an `AWS Notification - Subscription Confirmation` email to the address in `infra/terraform/observability.tf` (currently `macamp0328@gmail.com`). Click the confirmation link **once**. Until you do, alarms publish to SNS but no email is delivered.

Verify the subscription is active:

```bash
aws sns list-subscriptions-by-topic \
  --region "$REGION" \
  --topic-arn "$(terraform -chdir=infra/terraform output -raw sns_topic_arn)"
```

The subscription's `SubscriptionArn` should not be the literal string `PendingConfirmation`.

### Step 9b — Enable account-level billing alerts (one-time)

The `liner-notes-billing` alarm reads `AWS/Billing → EstimatedCharges`, but that metric is only published once the account opts into billing alerts. It is **not Terraform-manageable** — there is no IAM API for it. Do this once per AWS account:

1. Sign in to the [AWS Billing console](https://console.aws.amazon.com/billing/home#/preferences) as the account root user (the toggle is root-only).
2. Open **Billing → Billing preferences**.
3. Tick **Receive Billing Alerts** and save.

Until this is on, the billing alarm stays in `INSUFFICIENT_DATA` indefinitely — no harm done, but it also won't fire. Once enabled, the metric starts publishing every ~6 hours and the alarm becomes useful within a day.

### Step 10 — Install fluent-bit on the node

Same pattern as Step 5 (External Secrets Operator): helm against the local k3s API from an SSM session, not the laptop tunnel. The chart values are checked in at [`infra/k8s/aws-for-fluent-bit/values.yaml`](k8s/aws-for-fluent-bit/values.yaml) and pulled from the repo at apply time — do not paste them into the SSM terminal (Session Manager occasionally collapses newlines in long heredoc pastes, which silently drops sections of the values file).

Open an interactive SSM session:

```bash
aws ssm start-session --region "$REGION" --target "$INSTANCE_ID"
```

Inside the session:

```bash
sudo -i -u ec2-user
export KUBECONFIG=~/.kube/config

helm repo add eks https://aws.github.io/eks-charts
helm repo update

# Pull the values file from the repo. The raw URL is pinned to main so the
# version applied to prod is exactly what's been merged and reviewed.
curl -fsSL https://raw.githubusercontent.com/macamp0328/liner-notes/main/infra/k8s/aws-for-fluent-bit/values.yaml \
  > /tmp/fluent-bit-values.yaml

# Sanity-check the file landed intact — should print >= 100 lines and end
# with the `additionalFilters` [FILTER] grep block (issue #152). If it
# still ends with the systemd [INPUT] block, the values file pre-dates
# #152 and the log-group scoping filter is missing.
wc -l /tmp/fluent-bit-values.yaml
tail -8 /tmp/fluent-bit-values.yaml

# Resolve the node's region from IMDSv2 so fluent-bit ships to the same
# region terraform created the log group in, even if var.aws_region was
# overridden. The values file's static `region: us-east-1` is a fallback.
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
NODE_REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region)

# `--version 0.2.0` pins the chart to the version the values file was
# tested against. The values file re-declares the chart's default volumes
# because v0.2.0 has no extraVolumes/extraVolumeMounts append-style key —
# if the chart's defaults change in a later version, our override would
# silently drop them. Bump both in lockstep.
#
# If you've overridden var.project_name in terraform, also pass:
#   --set cloudWatchLogs.logGroupName=/<your-project-name>/graph-service
helm upgrade --install aws-for-fluent-bit eks/aws-for-fluent-bit \
  --version 0.2.0 \
  --namespace amazon-cloudwatch \
  --create-namespace \
  -f /tmp/fluent-bit-values.yaml \
  --set cloudWatchLogs.region="$NODE_REGION" \
  --wait --timeout 5m

kubectl -n amazon-cloudwatch get pods
```

**Expected:** ~1 minute. One `aws-for-fluent-bit-*` pod per node (just one — single-node k3s) in `Running 1/1`.

**Before leaving the SSM session, confirm the systemd input actually started:**

```bash
kubectl -n amazon-cloudwatch logs -l app.kubernetes.io/name=aws-for-fluent-bit \
  | grep -iE 'systemd|journal' | head -5
```

You should see lines like `[input:systemd:systemd.0]` indicating fluent-bit opened the journal. **Zero matching lines = the values file was applied but the systemd input never initialized** — investigate before continuing. The most common cause is the chart silently ignoring the values block (re-run `wc -l /tmp/fluent-bit-values.yaml` and compare against the repo file).

Then `exit` twice to leave the SSM session.

### Step 11 — Verify logs and alarms

Logs should appear in CloudWatch within ~30 seconds. From your laptop:

```bash
# Confirm BOTH streams are flowing — pod stdout and k3s systemd journal.
# The chart prepends `pod.` to every tag, so the systemd-sourced stream is
# `pod.k3s.k3s.service`, not bare `k3s.*`.
aws logs describe-log-streams \
  --region "$REGION" \
  --log-group-name /liner-notes/graph-service \
  --order-by LastEventTime --descending --max-items 10 \
  --query 'logStreams[].logStreamName' --output table
```

Expect a mix of `pod.kube.var.log.containers.*` streams (one per pod) and a single `pod.k3s.k3s.service` stream. If the `pod.k3s.*` stream is missing, jump back to the verification step in Step 10 — the rest of this section assumes the systemd input is producing data.

```bash
# Tail interleaved
aws logs tail /liner-notes/graph-service --region "$REGION" --since 5m --follow
```

#### Smoke-testing the alarms

The `liner-notes-pod-restarts` metric filter matches the phrases `"Liveness probe failed"` and `"CrashLoopBackOff"` against the `pod.k3s.k3s.service` stream's content. A graceful `kubectl delete pod` produces neither phrase — kubelet just logs the clean shutdown — so the alarm will not fire on that signal. Use a controlled crash-loop induction instead:

```bash
# Step 4b port-forward still running, KUBECONFIG still set. The graph-service
# deployment uses the Helm-style `app.kubernetes.io/name` label, not `app`.

# Patch the deployment so the container exits immediately. Kubelet will hit
# CrashLoopBackOff after a few restarts and log it to the k3s journal.
kubectl -n liner-notes patch deployment graph-service --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["false"]}]'

# Within ~3 min, "CrashLoopBackOff" should appear in CloudWatch
sleep 180
aws logs filter-log-events --region "$REGION" \
  --log-group-name /liner-notes/graph-service \
  --filter-pattern 'CrashLoopBackOff' --limit 3 \
  --query 'events[].message' --output text | head -5

# Wait the full alarm window (5 min total), then:
sleep 120
aws cloudwatch describe-alarms --region "$REGION" \
  --alarm-names liner-notes-pod-restarts \
  --query 'MetricAlarms[0].StateValue'
# Expect "ALARM" and an SNS email shortly after.

# Revert — restores the deployment's normal command and brings graph-service back up.
kubectl -n liner-notes rollout undo deployment graph-service
kubectl -n liner-notes rollout status deployment graph-service --timeout=2m
```

During the crash-loop induction the `liner-notes-health-check` (Route 53) alarm will also fire — `/api/v1/health` is unreachable while the container is exiting. That doubles as confirmation the external-probe path works. After the revert, both alarms transition back to `OK` over the next few minutes and an `OK` email arrives.

If `liner-notes-pod-restarts` stays `INSUFFICIENT_DATA` even with `CrashLoopBackOff` matches appearing in the log group, the metric filter pattern in [`infra/terraform/observability.tf`](terraform/observability.tf) needs review — the kubelet wording may have shifted between k8s versions.

The Route 53 health check by itself takes ~3–4 minutes from instance stop to email: 3 consecutive 30-second failures (~90s) before the health check flips to unhealthy, then 2 consecutive 1-min alarm periods (~2min) before the alarm fires.

---

## Redeploy procedure

```bash
export TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_URL"

docker buildx build \
  --platform linux/amd64 \
  -f services/graph-service/Dockerfile \
  -t "$ECR_URL:$TAG" \
  --push \
  .

cd infra/k8s/graph-service
kustomize edit set image "graph-service-image=$ECR_URL:$TAG"
kubectl apply -k .
kubectl -n liner-notes rollout status deployment/graph-service

# Don't commit the image override
git restore kustomization.yaml
cd "$(git rev-parse --show-toplevel)"
```

The Deployment uses `strategy: Recreate` — there will be ~30 seconds of downtime while the old pod terminates and the new one starts. Acceptable for a personal-project prod; a multi-AZ HA setup is out of scope.

> **Changed a secret value first?** If this redeploy follows an edit to `liner-notes/graph-service/prod` in Secrets Manager, force an immediate ESO sync so the new pod reads the updated value. The External Secrets Operator otherwise refreshes the in-cluster `graph-service-secrets` only hourly, and the pod reads env (`envFrom`) only at start — so a fresh pod can come up with the stale value:
>
> ```bash
> kubectl -n liner-notes annotate externalsecret graph-service-secrets force-sync=$(date +%s) --overwrite
> kubectl -n liner-notes get externalsecret graph-service-secrets   # LAST SYNC resets to a few seconds
> ```

---

## CD — IAM bootstrap

One-time setup that lets the CD workflow ([#120](https://github.com/macamp0328/liner-notes/issues/120)) deploy without long-lived AWS keys. [`infra/terraform/cicd.tf`](terraform/cicd.tf) declares a GitHub Actions OIDC identity provider and a scoped `github-deploy` IAM role; a hosted runner assumes the role via `sts:AssumeRoleWithWebIdentity`. The role can push images to ECR and open an SSM port-forward to the k3s API server — nothing more.

> **Run this manually, from the primary checkout, never in CI.** Terraform uses local state that lives in the **primary checkout** (not a worktree). Apply with your **admin `root` AWS profile** (the `liner-notes-admin` IAM user) — _not_ the scoped `default` profile (the `liner-notes-cli` operator user). This bootstrap creates an **account-wide** GitHub Actions OIDC provider (`aws_iam_openid_connect_provider.github`), and `iam:CreateOpenIDConnectProvider` is deliberately outside the operator's scope: [`operator-iam-policy.json`](iam/operator-iam-policy.json) scopes the operator's IAM role and instance-profile actions to `role/liner-notes-*` / `instance-profile/liner-notes-*` (`CreateRole`, `PutRolePolicy`, `PassRole`, and the like) plus read-only `iam:GetOpenIDConnectProvider` / `iam:ListOpenIDConnectProviderTags` (just enough for day-to-day operator applies to _refresh_ the provider and its `default_tags`), but grants **no** `iam:CreateOpenIDConnectProvider` or `iam:ListOpenIDConnectProviders`. Run with the operator profile and the create fails; even the `aws iam list-open-id-connect-providers` pre-check below returns `AccessDenied`. CI has no Terraform credentials and must never run `apply`. The role this creates is exactly what CI later _assumes_ — bootstrapping it from CI would be circular.

### Step 1 — Check for an existing OIDC provider

AWS permits exactly **one** OIDC provider per URL per account. If your account already has one for GitHub (e.g. from another project), reuse it instead of creating a second. Use the admin `root` profile — the scoped operator has read-only `iam:GetOpenIDConnectProvider` / `iam:ListOpenIDConnectProviderTags` (for refresh) but not `iam:ListOpenIDConnectProviders`, so the `list` call here returns `AccessDenied` under the operator profile (same reason the apply needs admin; see the callout above):

```bash
aws --profile root iam list-open-id-connect-providers
# Then inspect any ARN that looks like a GitHub provider:
aws --profile root iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
```

If `token.actions.githubusercontent.com` is **already present**, edit `cicd.tf` before applying: comment out the `aws_iam_openid_connect_provider.github` resource, uncomment the `data "aws_iam_openid_connect_provider" "github"` block, and flip `local.github_oidc_provider_arn` to `data.aws_iam_openid_connect_provider.github.arn`. The role trust policy reads the local, so nothing else changes. If there is **no** GitHub provider, leave `cicd.tf` as shipped — the resource form creates it.

### Step 2 — Apply

From the **primary checkout**, with the admin `root` profile (creating the account-wide OIDC provider is outside the operator's scope — see the callout above):

```bash
cd infra/terraform
AWS_PROFILE=root terraform apply         # type `yes` to confirm
```

On an established deployment, scope the apply to just the new resources so an unrelated drift elsewhere can't sneak in:

```bash
AWS_PROFILE=root terraform apply \
  -target=aws_iam_openid_connect_provider.github \
  -target=aws_iam_role.github_deploy \
  -target=aws_iam_role_policy.github_deploy
```

> **Reuse mode:** if you switched to the data source in Step 1 (account already has the GitHub OIDC provider), the `aws_iam_openid_connect_provider.github` resource is commented out — **drop its `-target` line**, since the data source is only read, never applied. Keep the two role targets. Still apply with `AWS_PROFILE=root`: reading the data source calls `iam:GetOpenIDConnectProvider`, which the scoped operator also lacks.

> **Forks:** the trust policy's `sub` claim defaults to `repo:macamp0328/liner-notes:environment:production`. Set `github_repository = "your-org/your-fork"` in `terraform.tfvars` (see `terraform.tfvars.example`) before applying, or the role will refuse your runner's token.

### Step 3 — Record the role ARN for CI

The workflow reads the role ARN from an `AWS_DEPLOY_ROLE_ARN` GitHub Actions **variable** (not a secret — a role ARN is not sensitive). Capture and set it:

```bash
ROLE_ARN=$(terraform output -raw github_deploy_role_arn)
echo "$ROLE_ARN"

# From the repo root, with the gh CLI authenticated:
gh variable set AWS_DEPLOY_ROLE_ARN --body "$ROLE_ARN"
```

Or set it via the GitHub UI under **Settings → Secrets and variables → Actions → Variables**. This unblocks #120.

---

## CD — cluster bootstrap

One-time setup of the scoped identity the CD workflow ([#120](https://github.com/macamp0328/liner-notes/issues/120)) authenticates as. That workflow runs `kubectl apply -k infra/k8s/graph-service` + `rollout status` from GitHub Actions and must use a **scoped** ServiceAccount — never the cluster-admin `/etc/rancher/k3s/k3s.yaml`. [`infra/k8s/deploy/github-deployer.yaml`](k8s/deploy/github-deployer.yaml) defines that identity: a `github-deployer` ServiceAccount, a long-lived token Secret, a least-privilege namespace Role/RoleBinding granting exactly what `apply -k` touches, and a one-resource ClusterRole/ClusterRoleBinding for the cluster-scoped `ClusterSecretStore`.

It is **deliberately not** part of the graph-service kustomization — the deployer can't create the identity it authenticates as — so you apply it once, by hand, with the admin kubeconfig. Run all three steps from your laptop with `KUBECONFIG` set and the [Step 4b](#step-4--get-a-kubeconfig-pointed-at-the-k3s-api-via-ssm-port-forward) port-forward still running.

**1. Apply the identity (admin kubeconfig):**

```bash
kubectl apply -f infra/k8s/deploy/github-deployer.yaml
# Expected: 6 × "created" — serviceaccount, secret, role.rbac, rolebinding.rbac,
#           clusterrole.rbac, clusterrolebinding.rbac.
```

**2. Verify the scope** — the grants should be `yes`, the deliberately-withheld ones `no`:

```bash
AS=system:serviceaccount:liner-notes:github-deployer

kubectl auth can-i create deployments        -n liner-notes --as="$AS"   # yes
kubectl auth can-i create roles              -n liner-notes --as="$AS"   # yes — escalation rule OK: holds a superset of the ecr-refresher Role's secret perms
kubectl auth can-i create rolebindings       -n liner-notes --as="$AS"   # yes
kubectl auth can-i create clustersecretstores               --as="$AS"   # yes — the one cluster-scoped grant
kubectl auth can-i create namespaces                        --as="$AS"   # no  — intentionally not granted
kubectl auth can-i delete deployments        -n liner-notes --as="$AS"   # no  — apply never deletes
```

**3. Mint the kubeconfig and set the GitHub secret.** The minter reads the SA token from the cluster, takes the cluster CA from your admin kubeconfig, templates a token-auth kubeconfig pointed at `https://127.0.0.1:6443`, and prints its base64 to stdout — pipe it straight into `gh`:

```bash
scripts/admin/mint-deploy-kubeconfig.sh | gh secret set KUBECONFIG_B64 --repo macamp0328/liner-notes

gh secret list --repo macamp0328/liner-notes    # KUBECONFIG_B64 should now be listed
```

> **Why `https://127.0.0.1:6443`, and why the admin CA?** The k3s API serving cert is signed only for `127.0.0.1` and the node's local IPs, so the kubeconfig must target the loopback address — the CD workflow (#120) reaches the API exactly as this runbook does, by opening its own SSM port-forward to `6443` before running `kubectl`. The minter takes `certificate-authority-data` from the admin kubeconfig rather than the SA token Secret's `ca.crt` because the admin config's CA is the trust anchor already proven (Step 4) to validate this server.

---

## CD — workflow setup

Final one-time wiring that turns the two bootstraps above into an automated pipeline. [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) ([#120](https://github.com/macamp0328/liner-notes/issues/120)) runs on every merge to `main` that touches `services/graph-service/**` or `infra/k8s/**` (and on manual `workflow_dispatch`): it assumes the deploy role via OIDC, builds + pushes the image to ECR, opens its own SSM port-forward to `6443`, then `kustomize edit set image` + `kubectl apply -k` + `rollout status` (auto-`rollout undo` on failure), and finally asserts `/api/v1/health` returns 200. The build + push live **inside** the gated deploy job — `ci.yml`'s `docker-build` stays build-only.

**1. Create the `production` GitHub environment with required reviewers.** This is the manual-approval gate: the deploy role's trust policy only mints the `:environment:production` OIDC sub claim _after_ a reviewer approves, so the role is unassumable until then.

```bash
# Settings → Environments → New environment → "production" → enable
# "Required reviewers" and add yourself. (No CLI for the reviewer gate.)
gh api -X PUT repos/macamp0328/liner-notes/environments/production >/dev/null   # creates it; set reviewers in the UI
```

**2. Set the repo variables** the workflow reads (all non-secret — ARNs, IDs, and URLs are not sensitive). `AWS_DEPLOY_ROLE_ARN` was set in [CD — IAM bootstrap](#cd--iam-bootstrap) Step 3; the rest come from `terraform output`:

```bash
cd infra/terraform
gh variable set AWS_REGION         --body "$(terraform output -raw aws_region)"
gh variable set EC2_INSTANCE_ID    --body "$(terraform output -raw ec2_instance_id)"
gh variable set ECR_REPOSITORY_URL --body "$(terraform output -raw ecr_repository_url)"
gh variable set SERVICE_URL        --body "$(terraform output -raw service_url)"
cd "$(git rev-parse --show-toplevel)"

gh variable list   # AWS_DEPLOY_ROLE_ARN, AWS_REGION, EC2_INSTANCE_ID, ECR_REPOSITORY_URL, SERVICE_URL
```

The `KUBECONFIG_B64` **secret** was set in [CD — cluster bootstrap](#cd--cluster-bootstrap) Step 3 — that's the only secret the workflow needs.

**3. Verify on the first deploy.** Merge a graph-service change (or run the workflow manually from the **Actions** tab), approve the `production` gate, and watch: the image lands in ECR under the short-SHA tag, `rollout status` completes, and the health gate goes green. To confirm the rollback path, once push a deliberately broken image (e.g. a bad start command) and check that the failed `rollout status` triggers `rollout undo` and the previous revision keeps serving.

> **Two caveats.**
>
> - **Health gate reachability.** The final step curls `SERVICE_URL` (`:30080`) from the GitHub runner. That works because `allow_app_cidr` defaults to `0.0.0.0/0` (open). If you've narrowed it (see `terraform.tfvars.example`) to your own IP, the runner can't reach `:30080` and the gate will fail — either keep `:30080` open or drop the health-gate step.
> - **Asleep node.** If the node is stopped (scale-to-zero), the pre-flight step fails fast with a "power on" message rather than hanging. Run `pnpm power:on`, wait for the SSM agent to register, then re-run the workflow from the **Actions** tab (`workflow_dispatch`) — no dummy commit needed.

---

## Full reload from scratch

Use this to discard the entire graph and rebuild it from Discogs — e.g. after a schema change, to clear stale nodes that `MERGE` can't remove (releases deleted from the collection), or to validate the ingestion + enrichment pipeline end-to-end on an empty graph.

> **The graph is fully reconstructable from Discogs.** There is no separate backup to restore; a wipe is safe by design. The only data that does _not_ come back automatically is the manual track-level enrichment (MusicBrainz/AcousticBrainz/Deezer), which you re-run explicitly in step 4.

**Prereqs.** Set `GRAPH_SERVICE_URL` and `ADMIN_TOKEN` once (the `pnpm` admin scripts read them from a gitignored `.env.local`, or export inline):

```bash
export GRAPH_SERVICE_URL="$SERVICE_URL"   # e.g. http://<EC2_DNS>:30080 — from the deploy env block
export ADMIN_TOKEN="$(aws secretsmanager get-secret-value \
  --secret-id liner-notes/graph-service/prod \
  --query SecretString --output text | jq -r '.ADMIN_TOKEN')"
```

**1. (Optional) Snapshot the current coverage** so you can compare before/after:

```bash
curl -s "$GRAPH_SERVICE_URL/api/v1/stats" | jq .
```

**2. Wipe the graph.** Double-gated (admin token + explicit confirm); see the [reset endpoint](../services/graph-service/src/api/admin.ts):

```bash
pnpm db:wipe
# → POST /api/v1/admin/reset?confirm=wipe-all → { "data": { "deleted": <nodeCount> } }
```

> **Requires the reset endpoint** (`POST /api/v1/admin/reset` + the `pnpm db:wipe` script) added in [#163](https://github.com/macamp0328/liner-notes/pull/163). Confirm the running image includes it before relying on this step. On an older build without the endpoint, wipe directly instead — `cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "MATCH (n) DETACH DELETE n"` (creds from the prod secret).

**3. Re-ingest.** An empty graph auto-triggers ingestion on pod start, so the cleanest trigger is a rollout restart (runs base ingestion + the in-pipeline enrichments: lyrics, master-data/originalYear, artist genres, track versions, artist profiles):

```bash
# Needs the Step 4b SSM port-forward running and KUBECONFIG set (see First-time deploy).
kubectl -n liner-notes rollout restart deployment/graph-service
aws logs tail /liner-notes/graph-service --follow   # watch enrichment stages; ~4 min for ~200 releases
```

Alternatively, trigger without a restart: `curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$GRAPH_SERVICE_URL/api/v1/admin/ingest"` (returns 202; poll `pnpm status:lyrics` etc.).

> **Changed a secret value (e.g. `GENIUS_TOKEN`) before this reload?** Force an ESO sync _before_ the rollout restart, or the new pod comes up with the stale value and that enrichment silently degrades (e.g. lyrics falls back to LRCLIB-only). ESO refreshes `graph-service-secrets` hourly; the pod reads env only at start:
>
> ```bash
> kubectl -n liner-notes annotate externalsecret graph-service-secrets force-sync=$(date +%s) --overwrite
> ```

**4. Run the manual track-level enrichments** — these are admin-only and **not** part of `runIngestion`, so they stay null after a reload until kicked off (MusicBrainz is 1 req/sec → the track-musicbrainz pass for ~2000 tracks takes ~30 min):

```bash
pnpm enrich:bootstrap
# mb-release-events → track-musicbrainz → (track-acousticbrainz ‖ track-deezer) → nationality
```

**5. Verify coverage** against the targets:

```bash
curl -s "$GRAPH_SERVICE_URL/api/v1/stats" | jq .data.enrichment
```

| Metric                     | Target                | Filled by                                      |
| -------------------------- | --------------------- | ---------------------------------------------- |
| `releasesWithOriginalYear` | ≥ 90%                 | step 3 (master-data)                           |
| `artistsWithProfile`       | ≥ 80%                 | step 3 (artist-profiles)                       |
| `tracksWithLyrics`         | best-effort           | step 3 (LRCLIB + Genius if `GENIUS_TOKEN` set) |
| `tracksWithRecordingMbid`  | high                  | step 4 (`track-musicbrainz`)                   |
| `tracksWithIsrc`           | high                  | step 4 (`track-musicbrainz`)                   |
| `tracksWithTempo`          | of those with an mbid | step 4 (`track-acousticbrainz`)                |
| `tracksWithDeezerBpm`      | of those with an isrc | step 4 (`track-deezer`)                        |

> `tracksWithLyrics` is LRCLIB-only (~70%) unless `GENIUS_TOKEN` is present in the prod secret — the Genius fallback is skipped when it's unset.

---

## Instance power switch — scale-to-zero

The k3s node doesn't need to run 24/7. A small Lambda (`liner-notes-instance-scheduler`, see [`infra/terraform/scheduler.tf`](terraform/scheduler.tf)) starts/stops it on demand and on a nightly schedule, suppressing the two transient alarms (`liner-notes-ec2-status-check`, `liner-notes-health-check`) while the node is intentionally down so a planned stop doesn't page you. A stopped EC2 node plus an auto-paused Aura instance (see "Resuming a paused Aura instance" below) is a coherent "asleep" state at ~$0/month.

> **One-time prerequisite.** `operator-deploy-policy.json` grants `lambda:InvokeFunction` on `function:liner-notes-*`. If you set this account up before [#118](https://github.com/macamp0328/liner-notes/issues/118), re-attach the operator policies per [`infra/iam/README.md`](iam/README.md) before the switch will work.

### The switch

Run from the repo root (uses your default AWS profile; honors `AWS_PROFILE`):

| Command             | What it does                                                                                                | When                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `pnpm power:off`    | Pauses the nightly schedule, suppresses the two alarms, stops the node. Stays down until you say otherwise. | Away for days/weeks.              |
| `pnpm power:on`     | Pauses the nightly schedule, starts the node, re-enables the alarms. Stays up — the 23:00 stop won't fire.  | Working now, including overnight. |
| `pnpm power:auto`   | Re-arms the nightly stop (23:00 ET) / start (08:00 ET) cost-saver and starts the node now.                  | Back to hands-off cost saving.    |
| `pnpm power:status` | Read-only: prints the instance state and each schedule's ENABLED/DISABLED state.                            | Checking where things stand.      |

Each command prints the resulting state, e.g.:

```json
{
  "action": "on",
  "instance": "running",
  "schedules": { "liner-notes-instance-stop": "DISABLED", "liner-notes-instance-start": "DISABLED" }
}
```

`on` and `off` are _manual overrides_ — both pause the schedule so it can't undo your choice. `auto` is the only mode that re-arms it. Out of the box the schedule is created **DISABLED** (`nightly_schedule_enabled = false` in [`variables.tf`](terraform/variables.tf)); set that var to `true` or run `pnpm power:auto` to opt in.

### What to expect on a cold start

`user_data` runs only on first boot, so a stopped→started node does **not** re-bootstrap — k3s, the EBS volume, kubeconfig, and in-cluster state persist across stop/start. After `pnpm power:on` / `pnpm power:auto`:

- Give the node ~1–2 minutes; k3s restarts the graph-service pod automatically.
- The ECR pull-secret CronJob refreshes every 6h; after a long stop the in-cluster `ecr-pull-secret` may be stale until the next fire. If the pod is stuck `ImagePullBackOff` with `unauthorized`, force a refresh: `kubectl -n liner-notes create job --from=cronjob/ecr-pull-secret-refresher refresh-now`, then `kubectl -n liner-notes rollout restart deployment/graph-service`.
- The first request is slow: the pod settles and **Aura resumes from its own pause** if it has been idle ≥72h (see below).
- The two transient alarms are re-enabled automatically — no manual alarm steps.

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

| Symptom                                                                                                              | First thing to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform apply` fails with `AccessDenied` on an IAM resource                                                       | Operator IAM policy from [`infra/iam/operator-iam-policy.json`](iam/operator-iam-policy.json) is not attached. See [`infra/iam/README.md`](iam/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `aws ssm start-session` fails with `not authorized to perform: ssm:StartSession`                                     | Operator SSM policy from [`infra/iam/operator-ssm-policy.json`](iam/operator-ssm-policy.json) is not attached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `aws ssm start-session` fails with `SessionManagerPlugin is not found`                                               | Install with `brew install --cask session-manager-plugin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `terraform plan` shows `forces replacement` on `aws_instance.k3s` after a successful apply                           | Should not happen — `lifecycle { ignore_changes = [ami] }` is in `ec2.tf` precisely to prevent this. If you see it, check that the lifecycle block is still in place.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Node OOM, `etcd failed`, load average way over 1× CPU                                                                | t3.micro is undersized — resize to t3.small. With state preserved: `aws ec2 stop-instances`, `aws ec2 modify-instance-attribute --instance-type '{"Value":"t3.small"}'`, `aws ec2 start-instances`. Public IP changes on stop/start without an EIP, so re-export `PUBLIC_DNS` / `SERVICE_URL` after.                                                                                                                                                                                                                                                                                           |
| `ExternalSecret SecretSyncedError: invalid character … after object key`                                             | The JSON in AWS Secrets Manager is malformed. Re-validate locally with `jq` and `put-secret-value` again. Then `kubectl annotate externalsecret -n liner-notes graph-service-secrets force-sync=$(date +%s) --overwrite` to retry immediately.                                                                                                                                                                                                                                                                                                                                                 |
| `ExternalSecret SecretSyncedError: AccessDenied`                                                                     | EC2 instance role is missing Secrets Manager read; verify `aws_iam_role_policy.secrets_read` in `infra/terraform/iam.tf` references the correct secret ARN.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `kubectl apply -k .` errors with `no matches for kind "ClusterSecretStore" in version "external-secrets.io/v1beta1"` | The ESO chart you installed has moved past `v1beta1`. Verify with `kubectl api-resources --api-group=external-secrets.io`, update the `apiVersion` in `external-secret.yaml`, re-apply.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Pod `ImagePullBackOff` with `no match for platform in manifest`                                                      | Image was built for the wrong architecture. Rebuild with `docker buildx build --platform linux/amd64 ... --push .` and delete the pod to force re-pull.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Pod `ImagePullBackOff` with `unauthorized` / `401`                                                                   | `kubectl -n liner-notes get secret ecr-pull-secret` — if missing or older than 12h, re-run Step 6 and force the refresher: `kubectl -n liner-notes create job --from=cronjob/ecr-pull-secret-refresher refresh-now`. Then `rollout restart` the Deployment.                                                                                                                                                                                                                                                                                                                                    |
| Pod `CrashLoopBackOff` on first deploy                                                                               | `kubectl -n liner-notes describe externalsecret graph-service-secrets` — `SecretSyncedError` means Step 2 didn't land cleanly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Pod restarts every ~minute                                                                                           | `kubectl -n liner-notes logs deployment/graph-service` — usually Neo4j: Aura paused, wrong `NEO4J_URI`, or a transient network blip.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `503` from `/api/v1/health` with `neo4j: disconnected`                                                               | Aura paused — see "Resuming a paused Aura instance".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Need to read graph-service logs without `kubectl`                                                                    | Logs ship to CloudWatch Log Group `/liner-notes/graph-service` via fluent-bit. Tail with `aws logs tail /liner-notes/graph-service --since 1h --follow`, or browse in the CloudWatch console.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Alarm fires but no email arrives                                                                                     | SNS email subscription wasn't confirmed. Re-check the inbox for the AWS confirmation link, or `aws sns list-subscriptions-by-topic` — a subscription stuck in `PendingConfirmation` doesn't deliver. To re-send: `terraform taint aws_sns_topic_subscription.email && terraform apply`.                                                                                                                                                                                                                                                                                                        |
| `liner-notes-pod-restarts` alarm stays `INSUFFICIENT_DATA`                                                           | fluent-bit's systemd input isn't shipping the k3s journal. Check that a `pod.k3s.k3s.service` log stream exists in the log group, and that `kubectl -n amazon-cloudwatch logs -l app.kubernetes.io/name=aws-for-fluent-bit \| grep systemd` returns non-empty. If both are empty, re-run Step 10 — the `additionalInputs` block in [`infra/k8s/aws-for-fluent-bit/values.yaml`](k8s/aws-for-fluent-bit/values.yaml) is the source of truth. Note: a graceful `kubectl delete pod` doesn't trigger this alarm; only liveness-probe failures and crash loops do — see the smoke-test in Step 11. |
| `helm install` fails with `cannot re-use a name that is still in use`                                                | A previous install left a stuck release record. Clean up: `kubectl delete secret -n external-secrets -l owner=helm` and `kubectl get crd -o name \| grep external-secrets.io \| xargs kubectl delete`. Then retry.                                                                                                                                                                                                                                                                                                                                                                             |
| `helm install` fails with TLS handshake timeouts from your laptop                                                    | The SSM port-forward chokes on helm's parallel API calls. Switch to running helm on the node via an interactive SSM session — Step 5 documents the pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Health endpoint unreachable from the internet                                                                        | EC2 security group: `aws_vpc_security_group_ingress_rule.app_nodeport` must allow your IP on `:30080`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `kubectl` from laptop hangs / times out                                                                              | The Step 4b SSM port-forward died (laptop sleep, network change). Re-run the `AWS-StartPortForwardingSession` command and retry. The k3s API is intentionally not exposed in the security group — SSM is the only path in.                                                                                                                                                                                                                                                                                                                                                                     |
| `kubectl` returns `x509: certificate valid for 127.0.0.1, …`                                                         | The kubeconfig server URL was rewritten away from `127.0.0.1`. Re-fetch with `aws ssm start-session ... 'command=["sudo cat /etc/rancher/k3s/k3s.yaml"]'` and leave `https://127.0.0.1:6443` intact; the port-forward bridges that local address to the API server.                                                                                                                                                                                                                                                                                                                            |
| k3s itself unhealthy                                                                                                 | In an SSM session: `sudo journalctl -u k3s -n 200`, `sudo systemctl status k3s`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Refresher CronJob failing                                                                                            | `kubectl -n liner-notes logs job/<latest-refresher-job>` — the job derives the ECR hostname from the instance role, so the usual failure is IMDS unreachable (`sts get-caller-identity` / `ecr get-login-password` can't reach the instance role — pod has lost connectivity or the metadata hop limit changed).                                                                                                                                                                                                                                                                               |
| `pnpm power:*` fails with `AccessDenied` on `lambda:InvokeFunction`                                                  | Operator policy predates [#118](https://github.com/macamp0328/liner-notes/issues/118) — re-attach `operator-deploy-policy.json` per [`infra/iam/README.md`](iam/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm power:*` fails with `ResourceNotFoundException`                                                                | The scheduler Lambda isn't deployed (`terraform apply`), or `project_name` was overridden — set `SCHEDULER_LAMBDA_NAME` to the `instance_scheduler_function_name` output.                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## Tear-down

```bash
cd infra/terraform
terraform destroy        # type `yes` to confirm
```

This deletes the EC2 instance, VPC, ECR repository (and all images — the repo is created with `force_delete = true`), IAM roles, and the Secrets Manager secret container. The Aura instance is **not** managed by Terraform — leave it alone if you want to keep the graph data.

> The Secrets Manager secret enters a 30-day recovery window after destroy; re-applying within 30 days hits `InvalidRequestException`. Either `aws secretsmanager delete-secret --force-delete-without-recovery` before re-applying, or wait it out.
