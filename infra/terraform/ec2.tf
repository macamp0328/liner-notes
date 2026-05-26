# Single-node k3s on EC2.
#
# user_data installs:
#   - k3s (single-node, writes kubeconfig to /etc/rancher/k3s/k3s.yaml)
#   - helm (used to install External Secrets Operator per the runbook)
#
# The instance profile attached here grants the node ECR pull + Secrets
# Manager read; External Secrets Operator inherits these via IMDS.

locals {
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail

    # k3s single-node, no Traefik (we expose graph-service via NodePort instead).
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable=traefik" sh -

    # Wait for k3s to become healthy before installing helm.
    until kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml get nodes >/dev/null 2>&1; do
      sleep 2
    done

    # Make kubectl/helm usable for the default user without sudo.
    mkdir -p /home/ec2-user/.kube
    cp /etc/rancher/k3s/k3s.yaml /home/ec2-user/.kube/config
    chown -R ec2-user:ec2-user /home/ec2-user/.kube
    chmod 600 /home/ec2-user/.kube/config

    # helm — used by the runbook to install External Secrets Operator.
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  EOT
}

resource "aws_instance" "k3s" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.k3s_node.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2_k3s.name
  key_name               = var.ssh_key_name
  user_data              = local.user_data

  # IMDSv2 required — External Secrets Operator and the AWS SDK pick up the
  # instance role from IMDS, and v2 is the modern, secure default.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2 # one hop for the host, one for pods
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = "${local.name_prefix}-k3s"
  }

  # `data.aws_ami.al2023 { most_recent = true }` resolves to whatever AL2023 AMI
  # Amazon publishes on each `terraform plan`. Without this, the next plan after
  # an AMI release would force a destroy/replace of a running prod node — losing
  # the EBS volume, kubeconfig, and any in-cluster state. Operators can still
  # opt in to a node refresh by tainting the resource, which is much safer than
  # the default behaviour.
  lifecycle {
    ignore_changes = [ami]
  }
}
