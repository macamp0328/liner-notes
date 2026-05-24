# Runtime secrets for graph-service.
#
# Terraform creates the *secret container*. The actual value is populated by
# the operator out-of-band (AWS console / `aws secretsmanager put-secret-value`)
# after the first `apply` — see infra/RUNBOOK.md.
#
# Rationale: keeping the value out of Terraform state avoids storing the Aura
# password (and other production credentials) in `terraform.tfstate`, and lets
# operators rotate credentials without a Terraform run.

resource "aws_secretsmanager_secret" "graph_service" {
  name        = "${local.name_prefix}/graph-service/prod"
  description = "Runtime env vars for graph-service (Aura, Discogs, admin token, optional lyrics enrichment)."

  # Aura is the source of truth for password rotation; do not let Terraform
  # try to manage individual secret versions.
  lifecycle {
    ignore_changes = [tags]
  }
}
