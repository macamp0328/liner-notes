# Bootstrap variables — see main.tf for context.

variable "aws_region" {
  description = "AWS region for the state bucket. MUST match the literal region in ../backend.tf — the S3 backend can't read a variable, so the two are coupled."
  type        = string
  default     = "us-east-1"

  # The backend can't interpolate a variable, so ../backend.tf hardcodes the
  # region. Fail fast if this drifts rather than creating the bucket in one
  # region while the backend points at another (which breaks `terraform init`).
  # To use a different region, change both this default and ../backend.tf.
  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "aws_region must be us-east-1 to match the hardcoded region in ../backend.tf."
  }
}

variable "project_name" {
  description = "Project name; prefixes the state bucket as <project_name>-tfstate-<account-id>. Override for forks."
  type        = string
  default     = "liner-notes"
}
