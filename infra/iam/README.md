# Operator IAM policies

The IAM user that runs `terraform apply` + `aws ssm` commands (called `liner-notes-cli` throughout the runbook) needs permissions beyond the EC2 + ECR full-access policies created during initial AWS account setup.

The two JSON files in this directory are the exact policies you attach to that user before running [`infra/RUNBOOK.md`](../RUNBOOK.md) Step 1. Both are scoped to this project's resources — the IAM policy by name prefix (`liner-notes-*`), the SSM policy by tag (`Project=liner-notes`, applied automatically by Terraform's `default_tags`) — so even if the user's credentials leak, the blast radius is contained.

| File                                                   | Attach as                                       | Why it's needed                                                                                                                                                                                                                                                                                                                                | How it's scoped                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`operator-iam-policy.json`](operator-iam-policy.json) | **Customer-managed policy** (see below for why) | Terraform creates an EC2 instance role + instance profile + role policies, plus the observability stack added in [#125](https://github.com/macamp0328/liner-notes/pull/125) (CloudWatch Log Group + alarms, SNS topic + subscription, Route 53 health check). Without these permissions, Step 1 (`terraform apply`) fails with `AccessDenied`. | Resource ARN match: `role/liner-notes-*`, `instance-profile/liner-notes-*`, `log-group:/liner-notes/*`, `alarm:liner-notes-*`, `sns:liner-notes-*`. Route 53 health checks don't support fine-grained ARNs, so those actions are `Resource: "*"` (still constrained by action verb to health-check management only). |
| [`operator-ssm-policy.json`](operator-ssm-policy.json) | Inline policy                                   | Step 4 onward uses SSM Session Manager to reach the k3s node (kubeconfig fetch, interactive shells, port-forwarding). Without these, every SSM command fails with `is not authorized to perform: ssm:StartSession`.                                                                                                                            | `StringEquals` condition on `ssm:resourceTag/Project = liner-notes` (set via Terraform `default_tags`). AWS-managed SSM documents are allowed in a separate statement.                                                                                                                                               |

## Why one is managed and one is inline

AWS caps the **aggregate non-whitespace size of all inline policies on a single IAM user at 2048 characters**. `operator-iam-policy.json` alone exceeds that limit (~2.4k after the observability scoping added in [#127](https://github.com/macamp0328/liner-notes/issues/127)), so attaching it inline silently fails when paired with anything else. Customer-managed policies have a 6144-char ceiling and are still versioned JSON that lives in this repo — so the JSON stays reviewable and forkable, only the attach mechanism changes.

`operator-ssm-policy.json` stays inline because it's small (~700 chars) and dedicating a managed policy to it would just be paperwork.

## How to attach (one-time, runs as the AWS account root or a privileged admin)

The `liner-notes-cli` user can't grant itself permissions, so these steps run as the AWS account root or any user with `IAMFullAccess`.

### Substitute your account ID into both policies

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-iam-policy.json > /tmp/liner-notes-iam.json
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-ssm-policy.json > /tmp/liner-notes-ssm.json
```

The `123456789012` literal in both files is the AWS documentation placeholder — it must be replaced before the policies will actually grant anything in your account.

### Create + attach `operator-iam-policy.json` as a customer-managed policy

**Console path** (matches the bootstrap pattern — no admin CLI credentials needed on your laptop):

1. Sign in to the AWS Console as the root account (or any user with `IAMFullAccess`).
2. **IAM → Policies → Create policy → JSON tab**.
3. Paste the contents of `/tmp/liner-notes-iam.json`. Click Next.
4. **Name:** `liner-notes-iam`. Create.
5. **IAM → Users → `liner-notes-cli` → Permissions → Add permissions → Attach policies directly**.
6. Search `liner-notes-iam`, check it, Next, Add permissions.

**CLI path** (if you have admin credentials configured, e.g. under `--profile root`):

```bash
aws --profile root iam create-policy \
  --policy-name liner-notes-iam \
  --policy-document file:///tmp/liner-notes-iam.json \
  --description "Scoped operator permissions for terraform apply against the liner-notes stack"

aws --profile root iam attach-user-policy \
  --user-name liner-notes-cli \
  --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/liner-notes-iam"
```

### Attach `operator-ssm-policy.json` as an inline policy

1. **IAM → Users → `liner-notes-cli` → Permissions → Add permissions → Create inline policy → JSON tab**.
2. Paste the contents of `/tmp/liner-notes-ssm.json`. Name it `liner-notes-ssm`. Save.

## Updating the managed policy

When `operator-iam-policy.json` changes in the repo, push a new version of the managed policy and set it as default. AWS keeps up to 5 versions per policy.

**Console path:**

1. **IAM → Policies → `liner-notes-iam` → Policy versions tab → Create new version**.
2. Paste the updated, sed-substituted JSON.
3. Check **Set this new version as the default**. Create version.
4. If you're at the 5-version cap, delete the oldest non-default version first.

**CLI path:**

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/liner-notes-iam"

sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-iam-policy.json > /tmp/liner-notes-iam.json

aws --profile root iam create-policy-version \
  --policy-arn "$POLICY_ARN" \
  --policy-document file:///tmp/liner-notes-iam.json \
  --set-as-default
```

The inline `operator-ssm-policy` is updated by re-pasting via the console (same path as initial attach) — no versioning, the new JSON replaces the old.

## Why not manage these through Terraform?

Chicken-and-egg. The user that runs `terraform apply` would need these permissions to grant them to itself. Manual attach via the console (or admin-credentialed CLI) keeps the bootstrap simple. The JSON is checked in here so the policies are reviewable and reproducible across forks.
