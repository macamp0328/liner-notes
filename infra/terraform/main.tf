# Terraform resources — Task 5 (infra sprint)
# See: Section 10 of the product spec (liner-notes-spec-v0.5.md in repo root)

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
}
