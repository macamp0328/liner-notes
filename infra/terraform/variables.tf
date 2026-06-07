# Terraform variables — production environment.

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used as a prefix for all resource names."
  type        = string
  default     = "liner-notes"
}

variable "instance_type" {
  description = "EC2 instance type for the k3s node. t3.small (2 vCPU / 2 GB) is the minimum that runs k3s + External Secrets Operator + graph-service without OOMing — t3.micro (1 GB) thrashes and the API server stops responding."
  type        = string
  default     = "t3.small"
}

variable "ssh_key_name" {
  description = "Name of an existing EC2 key pair to attach to the instance. Leave null to skip — operators can use SSM Session Manager once IAM is set up."
  type        = string
  default     = null
}

variable "allow_ssh_cidr" {
  description = "CIDR blocks permitted to SSH (port 22) into the k3s node. Empty list disables SSH from the security group; rely on SSM Session Manager instead."
  type        = list(string)
  default     = []
}

variable "allow_app_cidr" {
  description = "CIDR blocks permitted to reach the graph-service NodePort (30080). Default is open to the world; narrow this for tighter exposure. Ignored when restrict_app_to_cloudflare is true — the security group then only admits Cloudflare's IP ranges."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# --- TLS + custom domain via Cloudflare (issue #119) -------------------------
# All four default to the current behaviour: no Cloudflare, plain HTTP on
# :30080. Enabling is a two-phase rollout — see infra/RUNBOOK.md "TLS + custom
# domain (Cloudflare)". The Cloudflare API token is supplied out-of-band via
# the CLOUDFLARE_API_TOKEN environment variable, not as a variable.

variable "cloudflare_enabled" {
  description = "Create the Cloudflare DNS record, TLS zone settings, and origin-port rule that put Cloudflare in front of the graph-service NodePort. Requires cloudflare_zone_id, custom_domain, and the CLOUDFLARE_API_TOKEN env var. Default false leaves the deploy on plain HTTP and never configures the Cloudflare provider."
  type        = bool
  default     = false
}

variable "restrict_app_to_cloudflare" {
  description = "Lock the NodePort security group to Cloudflare's published IPv4 ranges (instead of allow_app_cidr) and repoint the Route 53 health check at the HTTPS domain. Set true only after verifying the Cloudflare path works end to end. Requires cloudflare_enabled."
  type        = bool
  default     = false
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID that owns custom_domain. Copy it from the Cloudflare dashboard (Overview → API → Zone ID). Required when cloudflare_enabled is true."
  type        = string
  default     = ""
}

variable "custom_domain" {
  description = "Fully-qualified hostname Cloudflare serves graph-service on, e.g. api.example.com. Kept out of committed defaults (public-repo safety) — supply it via a gitignored *.tfvars. Required when cloudflare_enabled is true."
  type        = string
  default     = ""
}

variable "nightly_schedule_enabled" {
  description = "Initial state of the nightly stop/start cost-saving schedules on first apply. The runtime switch (`pnpm power:on|off|auto`) takes over thereafter — terraform ignores later state changes — so this only decides whether the node sleeps on the schedule out of the box. Default false (manual control via the power switch)."
  type        = bool
  default     = false
}

variable "scheduler_timezone" {
  description = "IANA timezone the stop/start crons are evaluated in. EventBridge Scheduler handles DST automatically."
  type        = string
  default     = "America/New_York"
}

variable "scheduler_stop_cron" {
  description = "EventBridge Scheduler cron for the nightly stop, evaluated in scheduler_timezone. Default 23:00."
  type        = string
  default     = "cron(0 23 * * ? *)"
}

variable "scheduler_start_cron" {
  description = "EventBridge Scheduler cron for the nightly start, evaluated in scheduler_timezone. Default 08:00."
  type        = string
  default     = "cron(0 8 * * ? *)"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the CD deploy role via GitHub OIDC. Used in the trust policy's `sub` claim (repo:<owner/repo>:environment:production). Override for forks."
  type        = string
  default     = "macamp0328/liner-notes"
}
