# Remote state backend — S3 with native locking (use_lockfile, GA since
# Terraform 1.11; DynamoDB-based locking is deprecated). The state bucket is
# created once by the bootstrap module in ./bootstrap. See infra/RUNBOOK.md →
# "Remote Terraform state" for the one-time bootstrap + migration.
#
# Issue: https://github.com/macamp0328/liner-notes/issues/116

terraform {
  backend "s3" {
    key          = "graph-service/terraform.tfstate"
    region       = "us-east-1" # MUST match the bootstrap state bucket's region.
    encrypt      = true
    use_lockfile = true

    # `bucket` is intentionally omitted. The name is account-id-suffixed
    # (liner-notes-tfstate-<account-id>) and backend blocks take no
    # interpolation, so committing it would put an account id in a tracked file
    # — against the repo's public-safety rules. Supply it at init via
    # `-backend-config` instead; see backend.config.example.
  }
}
