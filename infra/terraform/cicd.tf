# CD trust + permissions for the deploy workflow (#120).
#
# Creates the GitHub Actions OIDC identity provider and a scoped IAM role a
# hosted runner assumes via sts:AssumeRoleWithWebIdentity — no long-lived AWS
# keys in GitHub. The role can push graph-service images to ECR and open an SSM
# port-forward to the k3s node (#120's deploy model: tunnel to the API server,
# then roll out with a scoped in-cluster service-account token).
#
# Bootstrap is manual: applied from the primary checkout with the admin `root`
# profile and local state, never in CI. The admin profile is required because
# aws_iam_openid_connect_provider.github is an account-wide OIDC provider and
# iam:CreateOpenIDConnectProvider is outside the scoped operator's permissions.
# The operator's IAM actions are scoped to role + instance-profile resources
# under liner-notes-*, plus read-only iam:GetOpenIDConnectProvider +
# iam:ListOpenIDConnectProviderTags (default_tags is on, so refresh reads the
# provider's tags) so its day-to-day terraform applies can refresh this provider
# — but not Create. See the "CD — IAM bootstrap" section of infra/RUNBOOK.md.

# --- GitHub OIDC identity provider ----------------------------------------
#
# AWS allows exactly one OIDC provider per URL per account. If one already
# exists (run `aws iam list-open-id-connect-providers` first — see RUNBOOK),
# comment out this resource, uncomment the data source below, and flip
# local.github_oidc_provider_arn to point at the data source. Nothing else
# changes — the role trust policy reads the local, not the resource directly.
#
# thumbprint_list is intentionally omitted: the AWS provider (v5) retrieves and
# manages the thumbprint automatically, and AWS validates GitHub's token-signing
# certificate against its trusted CA store regardless. Hardcoding a thumbprint
# only invites drift when GitHub rotates its CA.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Fallback for an account that already has the GitHub OIDC provider — comment
# out the resource above and uncomment this, then update the local below.
# data "aws_iam_openid_connect_provider" "github" {
#   url = "https://token.actions.githubusercontent.com"
# }

locals {
  # Single switch point for the resource/data-source toggle above. Flip to
  # data.aws_iam_openid_connect_provider.github.arn when using the fallback.
  github_oidc_provider_arn = aws_iam_openid_connect_provider.github.arn

  # AWS-managed public document the deploy uses to port-forward to the k3s API
  # server on the node (same document the RUNBOOK kubeconfig fetch uses). AWS
  # public documents carry no account ID, hence the empty account field.
  ssm_port_forward_document_arn = "arn:aws:ssm:${var.aws_region}::document/AWS-StartPortForwardingSession"
}

# --- Deploy role ----------------------------------------------------------
#
# Trust scoped to the production environment of this repo. The
# `:environment:production` sub claim is only minted after the workflow's
# production reviewer gate clears, so the role is unassumable until a human
# approves the deploy — defence in depth on top of the repo/identity check.
data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:production"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name_prefix}-github-deploy"
  description        = "Assumed by the CD workflow (#120) via GitHub OIDC to push images and roll out graph-service."
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  # Push graph-service images to the project's ECR repository.
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.graph_service.arn]
  }

  # GetAuthorizationToken returns an account-wide registry token and is not
  # scopable to a single repository — AWS requires "*".
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Open an SSM port-forward to the k3s node's API server. StartSession is
  # locked to the one instance AND the one AWS-managed port-forward document,
  # so this can't start an interactive shell or forward to any other host.
  statement {
    sid     = "SsmStartPortForward"
    actions = ["ssm:StartSession"]
    resources = [
      aws_instance.k3s.arn,
      local.ssm_port_forward_document_arn,
    ]
  }

  # Tear down / resume only the runner's own sessions. The ${aws:userid}
  # policy variable resolves to the assumed-role session, so this can't touch
  # an operator's session. (#120 sets the role-session-name the prefix matches.)
  statement {
    sid       = "SsmManageOwnSession"
    actions   = ["ssm:TerminateSession", "ssm:ResumeSession"]
    resources = ["arn:aws:ssm:*:*:session/$${aws:userid}-*"]
  }

  # DescribeInstanceInformation has no resource-level scoping in IAM — the
  # deploy uses it to confirm the SSM agent is online before tunnelling.
  statement {
    sid       = "SsmDescribe"
    actions   = ["ssm:DescribeInstanceInformation"]
    resources = ["*"]
  }

  # Scale-to-zero guard: the deploy checks the node is running (not mid
  # stop/start) before it tunnels. Neither Describe action supports
  # resource-level scoping in IAM — same constraint as scheduler.tf.
  statement {
    sid       = "Ec2DescribeGuard"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"]
    resources = ["*"]
  }

  # Confirm the runtime secret exists. The value is read in-cluster by External
  # Secrets Operator, not here — scoped to exactly the graph-service secret.
  statement {
    sid       = "SecretsDescribe"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.graph_service.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${local.name_prefix}-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
