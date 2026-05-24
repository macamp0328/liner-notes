# Terraform root — production environment for graph-service.
#
# Issue: https://github.com/macamp0328/liner-notes/issues/102
# Architecture: k3s single-node Kubernetes on EC2 t3.micro, Aura Free as the
# graph database, AWS Secrets Manager holds runtime credentials.
#
# Apply procedure and post-apply steps are documented in infra/RUNBOOK.md.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
      Component = "graph-service"
    }
  }
}

data "aws_caller_identity" "current" {}

# Amazon Linux 2023 — official AMI, refreshed on every plan.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  name_prefix = var.project_name
}
