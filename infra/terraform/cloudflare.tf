# TLS + custom domain for graph-service via Cloudflare (issue #119).
#
# Cloudflare proxies the custom hostname, terminates TLS for free, and forwards
# to the EC2 origin. Every resource here is gated on var.cloudflare_enabled, so
# the default deploy (flag false) never evaluates them and Terraform never even
# configures the Cloudflare provider — no API token needed until you opt in.
#
# Why an origin rule: Cloudflare connects to the origin on a standard port
# derived from the request (80 for HTTP/Flexible, 443 for HTTPS), never a
# non-standard NodePort like :30080 — and nothing serves :80/:443 on the host.
# The http_request_origin ruleset below rewrites the origin port to 30080 — a
# free-plan Origin Rule.
# (Overriding the origin host/SNI is Enterprise-only, so the CNAME must resolve
# to the real origin; we override only the port.)
#
# SSL mode is "flexible": browser<->Cloudflare is HTTPS, Cloudflare<->origin
# stays HTTP on :30080 as the issue specifies. The plaintext Cloudflare->origin
# hop is mitigated by restrict_app_to_cloudflare, which locks the security group
# to Cloudflare's IP ranges (see networking.tf).

# restrict_app_to_cloudflare only takes effect alongside cloudflare_enabled.
# Gating on both flags makes it structurally impossible to lock the origin
# security group / flip the health check to the (then non-existent) Cloudflare
# domain without the DNS record and origin rule also being created. The
# fail-fast plan-time guard lives as a cross-variable validation on
# restrict_app_to_cloudflare in variables.tf (unblocked once the diagram
# generator stopped feeding inframap the resource-free files — see #265); this
# structural local is kept as a backstop.
locals {
  restrict_to_cloudflare = var.restrict_app_to_cloudflare && var.cloudflare_enabled
}

resource "cloudflare_dns_record" "api" {
  count = var.cloudflare_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.custom_domain
  type    = "CNAME"
  content = aws_eip.k3s.public_dns
  proxied = true
  ttl     = 1 # 1 = automatic; Cloudflare requires this when proxied.
}

resource "cloudflare_zone_setting" "ssl" {
  count = var.cloudflare_enabled ? 1 : 0

  zone_id    = var.cloudflare_zone_id
  setting_id = "ssl"
  value      = "flexible"
}

resource "cloudflare_zone_setting" "always_use_https" {
  count = var.cloudflare_enabled ? 1 : 0

  zone_id    = var.cloudflare_zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  count = var.cloudflare_enabled ? 1 : 0

  zone_id    = var.cloudflare_zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

# Origin Rule: rewrite the resolved origin port to the graph-service NodePort.
resource "cloudflare_ruleset" "origin_port" {
  count = var.cloudflare_enabled ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = "${local.name_prefix}-origin-port"
  kind    = "zone"
  phase   = "http_request_origin"

  rules = [{
    action      = "route"
    description = "Route graph-service traffic to the NodePort (30080) on the origin."
    enabled     = true
    expression  = "(http.host eq \"${var.custom_domain}\")"
    action_parameters = {
      origin = {
        port = 30080
      }
    }
  }]
}

# Cloudflare's published IPv4 ranges — used to lock the NodePort security group
# to Cloudflare-only traffic. Read only when restrict_app_to_cloudflare is true.
# IPv4 only: the VPC has no IPv6 CIDR, so Cloudflare reaches the origin over v4.
data "cloudflare_ip_ranges" "cloudflare" {
  count = local.restrict_to_cloudflare ? 1 : 0
}
