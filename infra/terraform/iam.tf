# IAM role attached to the k3s EC2 instance.
#
# The pod-side External Secrets Operator inherits this role via the EC2
# instance profile (IMDS / default AWS SDK credential chain), so it does not
# need static AWS access keys to read Secrets Manager.

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_k3s" {
  name               = "${local.name_prefix}-ec2-k3s"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Pull container images from the project's ECR repository.
resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ec2_k3s.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Optional: allow operator access via Session Manager instead of SSH (no key pair required).
resource "aws_iam_role_policy_attachment" "ssm_managed" {
  role       = aws_iam_role.ec2_k3s.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Lets the in-cluster fluent-bit daemonset (installed via helm — see RUNBOOK)
# write to the graph-service CloudWatch Log Group. fluent-bit picks up these
# permissions from the EC2 instance role via IMDS; no IRSA / OIDC needed because
# k3s does not run an OIDC provider.
resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.ec2_k3s.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# Read access scoped to exactly the one secret we created.
data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid     = "ReadGraphServiceSecret"
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [
      aws_secretsmanager_secret.graph_service.arn,
    ]
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "${local.name_prefix}-secrets-read"
  role   = aws_iam_role.ec2_k3s.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

resource "aws_iam_instance_profile" "ec2_k3s" {
  name = "${local.name_prefix}-ec2-k3s"
  role = aws_iam_role.ec2_k3s.name
}
