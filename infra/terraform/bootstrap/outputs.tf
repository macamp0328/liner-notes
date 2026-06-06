# Bootstrap outputs.

output "state_bucket_name" {
  description = "Name of the S3 bucket holding the main config's remote state. Pass to `terraform init -backend-config=\"bucket=<name>\"` in ../ (or copy into ../backend.config)."
  value       = aws_s3_bucket.state.id
}
