# Operator IAM policies

The IAM user that runs `terraform apply` + `aws ssm` commands (called `liner-notes-cli` throughout the runbook) needs permissions beyond the EC2 + ECR full-access policies created during initial AWS account setup.

The two JSON files in this directory are the exact policies you attach as **inline policies** to that user before running [`infra/RUNBOOK.md`](../RUNBOOK.md) Step 1. Both are scoped to this project's resources — the IAM policy by name prefix (`liner-notes-*`), the SSM policy by tag (`Project=liner-notes`, applied automatically by Terraform's `default_tags`) — so even if the user's credentials leak, the blast radius is contained.

| File                                                   | Why it's needed                                                                                                                                                                                                     | How it's scoped                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`operator-iam-policy.json`](operator-iam-policy.json) | Terraform creates an EC2 instance role + instance profile + role policies. Without these IAM permissions, Step 1 (`terraform apply`) fails at the IAM resources with `AccessDenied`.                                | Resource ARN match: `role/liner-notes-*`, `instance-profile/liner-notes-*`                                                                                             |
| [`operator-ssm-policy.json`](operator-ssm-policy.json) | Step 4 onward uses SSM Session Manager to reach the k3s node (kubeconfig fetch, interactive shells, port-forwarding). Without these, every SSM command fails with `is not authorized to perform: ssm:StartSession`. | `StringEquals` condition on `ssm:resourceTag/Project = liner-notes` (set via Terraform `default_tags`). AWS-managed SSM documents are allowed in a separate statement. |

## How to attach (one-time, runs as the AWS account root or a privileged admin)

1. Sign in to the AWS Console as the root account (or any user with `IAMFullAccess`).
2. **IAM → Users → `liner-notes-cli` → Permissions → Add permissions → Create inline policy → JSON tab**.
3. Paste the contents of `operator-iam-policy.json`. Name it `liner-notes-iam`. Save.
4. Repeat with `operator-ssm-policy.json`. Name it `liner-notes-ssm`. Save.

The account ID `123456789012` in the resource ARNs is the AWS documentation placeholder. Replace it with your real account ID before attaching **both** policies — either by hand-editing the JSON in the console paste, or by piping through `sed`:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Copy the substituted IAM policy to clipboard, paste in the console as
# the `liner-notes-iam` inline policy, save.
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-iam-policy.json | pbcopy

# Then do the same for the SSM policy as `liner-notes-ssm`.
sed "s/123456789012/$ACCOUNT_ID/g" infra/iam/operator-ssm-policy.json | pbcopy
```

## Why not manage these through Terraform?

Chicken-and-egg. The user that runs `terraform apply` would need these permissions to grant them to itself. Manual attach via the console keeps the bootstrap simple. The JSON is checked in here so the policy is reviewable and reproducible across forks.
