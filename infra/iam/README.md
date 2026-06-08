# Operator IAM policies

The IAM user that runs `terraform apply` + `aws ssm` commands (called `liner-notes-cli` throughout the runbook) needs permissions beyond the EC2 + ECR full-access policies created during initial AWS account setup.

The three JSON files in this directory are the exact policies you attach to that user before running [`infra/RUNBOOK.md`](../RUNBOOK.md) Step 1. All three are scoped to this project's resources — the IAM and deploy policies by name prefix or tag on `liner-notes-*` resources, the SSM policy by tag (`Project=liner-notes`, applied automatically by Terraform's `default_tags`) — so even if the user's credentials leak, the blast radius is contained.

| File                                                         | Attach as                   | Why it's needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | How it's scoped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`operator-iam-policy.json`](operator-iam-policy.json)       | **Customer-managed policy** | Terraform creates an EC2 instance role + instance profile + role policies, plus the observability stack added in [#125](https://github.com/macamp0328/liner-notes/pull/125) (CloudWatch Log Group + alarms, SNS topic + subscription, Route 53 health check) and the dashboard added in [#126](https://github.com/macamp0328/liner-notes/issues/126). Without these permissions, Step 1 (`terraform apply`) fails with `AccessDenied`. It also grants **read-only** `iam:GetOpenIDConnectProvider` + `iam:ListOpenIDConnectProviderTags` on the GitHub Actions OIDC provider (added in [#209](https://github.com/macamp0328/liner-notes/pull/209)) so the operator's day-to-day `terraform apply` can _refresh_ that account-wide resource — the provider runs with `default_tags`, so refresh reads its tags as well as its core attributes; admin creates it (see [CD — IAM bootstrap](../RUNBOOK.md#cd--iam-bootstrap)), and without the read grant a plain operator apply fails on **refresh** with `AccessDenied`. | Resource ARN match: `role/liner-notes-*`, `instance-profile/liner-notes-*`, `log-group:/liner-notes/*`, `log-group:/aws/lambda/liner-notes-*` (the scheduler Lambda's own log group), `alarm:liner-notes-*`, `dashboard/liner-notes-*`, `sns:liner-notes-*`. Route 53 health checks, `cloudwatch:ListDashboards`, and the read-only metric query actions (`cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`) don't support fine-grained ARNs, so those actions are `Resource: "*"` (still constrained by action verb). The read-only `iam:GetOpenIDConnectProvider` + `iam:ListOpenIDConnectProviderTags` grants are scoped to the single `oidc-provider/token.actions.githubusercontent.com` ARN — no `iam:ListOpenIDConnectProviders` enumeration, no write actions. |
| [`operator-deploy-policy.json`](operator-deploy-policy.json) | **Customer-managed policy** | Terraform creates the VPC + EC2 + EIP + ECR + Secrets Manager resources that make up the deploy target, plus the scale-to-zero scheduler Lambda + EventBridge schedules added in [#118](https://github.com/macamp0328/liner-notes/issues/118). The runbook's manual flows (`docker push`, `aws secretsmanager put-secret-value`, instance start/stop for resize, `pnpm power:*`) also use these. Without these permissions, `terraform apply` and the runbook commands fail with `AccessDenied`. It also grants S3 list/read/write on the remote-state bucket (`liner-notes-tfstate-<account-id>`, added in [#116](https://github.com/macamp0328/liner-notes/issues/116)) so the operator's `terraform apply` can read state and acquire the `use_lockfile` lock.                                                                                                                                                                                                                                                       | EC2 actions scoped via `aws:RequestTag/Project=liner-notes` on create and `ec2:ResourceTag/Project=liner-notes` on modify/delete (since most EC2 actions don't accept resource-level ARNs). ECR scoped to `repository/liner-notes/*`. Secrets Manager scoped to `secret:liner-notes/*`. Lambda scoped to `function:liner-notes-*` (includes `lambda:InvokeFunction` for the `pnpm power:*` switch). EventBridge Scheduler scoped to `schedule/default/liner-notes-*`. Describe/list verbs and `ecr:GetAuthorizationToken` are `Resource: "*"` carve-outs (no resource-level support). Remote-state S3 actions scoped to the `liner-notes-tfstate-<account-id>` bucket plus its `graph-service/*` key prefix (covers both the state object and its `.tflock` lock object).                                   |
| [`operator-ssm-policy.json`](operator-ssm-policy.json)       | Inline policy               | Step 4 onward uses SSM Session Manager to reach the k3s node (kubeconfig fetch, interactive shells, port-forwarding). Without these, every SSM command fails with `is not authorized to perform: ssm:StartSession`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `StringEquals` condition on `ssm:resourceTag/Project = liner-notes` (set via Terraform `default_tags`). AWS-managed SSM documents are allowed in a separate statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

> **Heads-up for existing deployments:** the read-only `iam:GetOpenIDConnectProvider` + `iam:ListOpenIDConnectProviderTags` grants on `operator-iam-policy.json` were added once the GitHub OIDC provider ([#209](https://github.com/macamp0328/liner-notes/pull/209)) entered Terraform state. If your `liner-notes-iam` managed policy predates it, push a new version (see [Updating a managed policy](#updating-a-managed-policy)) — otherwise the operator's day-to-day `terraform apply` fails on **refresh** of the provider with `AccessDenied`.

> **Heads-up for existing deployments:** the `s3:*` remote-state grant on `operator-deploy-policy.json` was added with the move to a remote S3 backend ([#116](https://github.com/macamp0328/liner-notes/issues/116)). If your `liner-notes-deploy` managed policy predates it, push a new version (see [Updating a managed policy](#updating-a-managed-policy)) **before** running `terraform init -migrate-state` as the operator — otherwise state reads and `use_lockfile` locking fail with `AccessDenied`. (The one-time bucket creation + migration steps live in [`infra/RUNBOOK.md`](../RUNBOOK.md#remote-terraform-state).)

> **Heads-up for existing deployments:** `ec2:AuthorizeSecurityGroupIngress` / `ec2:AuthorizeSecurityGroupEgress` were moved into the `aws:RequestTag/Project=liner-notes`-scoped create statement (`CreateLinerNotesEc2Resources`) on `operator-deploy-policy.json` ([#266](https://github.com/macamp0328/liner-notes/issues/266)). They previously sat only in the `ec2:ResourceTag/Project`-scoped modify statement, which a **brand-new** security-group rule can never match (it has no tag yet) — so any operator `terraform apply` that _added_ an ingress/egress rule (e.g. the [#119](https://github.com/macamp0328/liner-notes/issues/119) Cloudflare lockdown) failed with `UnauthorizedOperation` on `security-group-rule/*`, while `Revoke` (acting on an existing tagged rule) succeeded — risking a partial-apply outage. Terraform tags the new rule via `default_tags` in the `Authorize*` call (the `CreateTags` half is already covered by `TagOnCreateEc2`), so the request-tag condition matches. If your `liner-notes-deploy` managed policy predates this, push a new version (see [Updating a managed policy](#updating-a-managed-policy)) — otherwise security-group ingress changes still require the admin `root` profile.

## Why some are managed and one is inline

AWS caps the **aggregate non-whitespace size of all inline policies on a single IAM user at 2048 characters**. `operator-iam-policy.json` and `operator-deploy-policy.json` each exceed that limit on their own (~2.4k and ~3.8k respectively), so attaching either inline silently fails when paired with anything else. Customer-managed policies have a 6144-char ceiling and are still versioned JSON that lives in this repo — so the JSON stays reviewable and forkable, only the attach mechanism changes.

`operator-ssm-policy.json` stays inline because it's small (~700 chars) and dedicating a managed policy to it would just be paperwork.

## How to attach (one-time, runs as the AWS account root or a privileged admin)

The `liner-notes-cli` user can't grant itself permissions, so these steps run as the AWS account root or any user with `IAMFullAccess`.

### Substitute your account ID into all three policies

These commands assume admin credentials are configured under a CLI profile named `root` (see the CLI path below). If you're going through the console path, set `ACCOUNT_ID` manually to your target account ID instead of using the `sts` call.

```bash
ACCOUNT_ID=$(aws --profile root sts get-caller-identity --query Account --output text)
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-iam-policy.json    > /tmp/liner-notes-iam.json
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-deploy-policy.json > /tmp/liner-notes-deploy.json
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-ssm-policy.json    > /tmp/liner-notes-ssm.json
```

The `123456789012` literal in all three files is the AWS documentation placeholder — it must be replaced before the policies will actually grant anything in your account. The `--profile root` is the same profile used by the CLI commands below, so the ARN baked into the substituted JSON always matches the account where the policy is created.

### Create + attach the customer-managed policies

For each of `liner-notes-iam` and `liner-notes-deploy`:

**Console path** (matches the bootstrap pattern — no admin CLI credentials needed on your laptop):

1. Sign in to the AWS Console as the root account (or any user with `IAMFullAccess`).
2. **IAM → Policies → Create policy → JSON tab**. Paste `/tmp/liner-notes-iam.json` (or `/tmp/liner-notes-deploy.json`). Click Next.
3. **Name:** `liner-notes-iam` (or `liner-notes-deploy`). Create.
4. **IAM → Users → `liner-notes-cli` → Permissions → Add permissions → Attach policies directly**.
5. Search the policy name, check it, Next, Add permissions.

**CLI path** (if you have admin credentials configured, e.g. under `--profile root`):

```bash
for name in liner-notes-iam liner-notes-deploy; do
  aws --profile root iam create-policy \
    --policy-name "$name" \
    --policy-document "file:///tmp/$name.json"

  aws --profile root iam attach-user-policy \
    --user-name liner-notes-cli \
    --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$name"
done
```

### Attach `operator-ssm-policy.json` as an inline policy

1. **IAM → Users → `liner-notes-cli` → Permissions → Add permissions → Create inline policy → JSON tab**.
2. Paste `/tmp/liner-notes-ssm.json`. Name it `liner-notes-ssm`. Save.

## Updating a managed policy

When `operator-iam-policy.json` or `operator-deploy-policy.json` changes in the repo, push a new version of the corresponding managed policy and set it as default. AWS keeps up to 5 versions per policy — delete the oldest non-default version if you hit the cap.

**Console:** IAM → Policies → `<policy-name>` → Policy versions → Create new version → paste the updated, sed-substituted JSON → check "Set this new version as the default" → Create version.

**CLI:**

```bash
ACCOUNT_ID=$(aws --profile root sts get-caller-identity --query Account --output text)
NAME=liner-notes-deploy   # or liner-notes-iam

sed "s/123456789012/$ACCOUNT_ID/g" "infra/iam/operator-${NAME#liner-notes-}-policy.json" > "/tmp/$NAME.json"

aws --profile root iam create-policy-version \
  --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$NAME" \
  --policy-document "file:///tmp/$NAME.json" \
  --set-as-default
```

`sts get-caller-identity` uses `--profile root` so the resolved `ACCOUNT_ID` matches the account `create-policy-version` will write to — without it, a contributor whose default profile points at a different account would silently target the wrong policy.

The inline `operator-ssm-policy` is updated by re-pasting via the console (same path as initial attach) — no versioning, the new JSON replaces the old.

## Why not manage these through Terraform?

Chicken-and-egg. The user that runs `terraform apply` would need these permissions to grant them to itself. Manual attach via the console (or admin-credentialed CLI) keeps the bootstrap simple. The JSON is checked in here so the policies are reviewable and reproducible across forks.
