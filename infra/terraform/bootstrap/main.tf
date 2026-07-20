# Bootstrap — creates the S3 bucket that holds the remote Terraform state for
# the main config in ../. This is a separate root module with its own LOCAL
# state: the main config's backend depends on this bucket existing, so the main
# config can't create the bucket itself (chicken-and-egg). Apply this once, then
# leave it alone.
#
# Issue: https://github.com/macamp0328/liner-notes/issues/116
# Backend wiring and the one-time state migration are documented in
# infra/RUNBOOK.md → "Remote Terraform state".

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
    tags = local.default_tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  # Account-id suffix keeps the name globally unique (S3 bucket names are global)
  # and fork-safe — two accounts never collide — without committing the account
  # id anywhere: it's resolved at apply time, never written to a tracked file.
  state_bucket_name = "${var.project_name}-tfstate-${data.aws_caller_identity.current.account_id}"

  default_tags = {
    Project   = var.project_name
    ManagedBy = "terraform"
    Component = "tf-state"
  }
}

# No access logging: there is no log-target bucket; the bucket is private,
# TLS-only (policy below), and versioned.
#trivy:ignore:AVD-AWS-0089
resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket_name

  # This bucket holds the remote state for the entire main config. A stray
  # `terraform destroy` here would orphan it — block the bucket from deletion.
  lifecycle {
    prevent_destroy = true
  }
}

# Versioning is the recovery net: a corrupt or truncated state push can be rolled
# back to a prior version. HashiCorp recommends it for state buckets.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 (AES256) encrypts state at rest at no cost. A customer-managed KMS key
# would add ~$1/month plus per-request charges for no meaningful benefit here.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Deny any request that isn't over TLS. State can carry sensitive resource
# attributes, so it must never travel in plaintext.
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.state.arn,
          "${aws_s3_bucket.state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
}
