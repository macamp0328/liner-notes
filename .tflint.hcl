# tflint — Terraform anti-pattern + AWS misconfiguration scanning (issue #348).
#
# Layered on top of the `terraform fmt -check` + `validate` gate from #344, which
# only checks syntax/references — not lint rules or AWS provider correctness.
#
# The built-in `terraform` ruleset `recommended` preset enforces documented + typed
# variables/outputs, no unused declarations, snake_case naming, pinned
# required_version/required_providers, the standard file layout, and flags
# deprecated interpolation / comment syntax. The `aws` ruleset adds AWS-specific
# checks: invalid instance types, deprecated arguments, missing required fields.
#
# The AWS plugin is pinned by version + source; `tflint --init` verifies its
# checksum and signature on download. Baseline is clean on both roots
# (infra/terraform and infra/terraform/bootstrap) — no rule suppressions needed.

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.47.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
