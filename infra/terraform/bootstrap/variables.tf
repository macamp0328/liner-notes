# Bootstrap variables — see main.tf for context.

variable "aws_region" {
  description = "AWS region for the state bucket. MUST match the literal region in ../backend.tf — the S3 backend can't read a variable, so the two are coupled."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name; prefixes the state bucket as <project_name>-tfstate-<account-id>. Override for forks."
  type        = string
  default     = "liner-notes"
}
