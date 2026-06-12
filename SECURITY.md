# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| main    | ✅        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use either private channel:

- **GitHub Private Vulnerability Reporting** — open the repo's **Security → Report a vulnerability**
  tab (preferred; keeps the report and fix linked on GitHub).
- **Email** — **macamp0328@gmail.com**.

Include as much of the following information as possible:

- Type of issue (e.g. exposed credential, injection vulnerability, authentication bypass)
- Full path(s) of source file(s) related to the issue
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

You should receive a response within 48 hours. If not, please follow up.

## Scope

This is a personal open-source project. The primary concern is:

- **Secrets exposure** — credentials committed to git history
- **Injection vulnerabilities** — in the Cypher query layer or API inputs
- **Dependency vulnerabilities** — critical CVEs in dependencies

### Deployed surface

The reference deployment runs a **public HTTPS API** at `ln-api.impressivelyadequate.com`. Cloudflare
proxies the hostname and terminates TLS; the EC2/k3s origin's security group accepts traffic **only
from Cloudflare's IP ranges** (#119), so the NodePort is not reachable directly. Read endpoints
(`/api/v1/*`, `/health`, `/stats`) are unauthenticated; all mutating `/api/v1/admin/*` routes require
an `Authorization: Bearer <ADMIN_TOKEN>` and are exempt from the public rate limiter. Forks that have
not configured a Cloudflare zone run on plain HTTP with no origin lockdown — treat that as
develop-only, not a hardened deployment.

## Disclosure Policy

- We will acknowledge receipt of your report within 48 hours
- We will confirm the issue and communicate a timeline for a fix
- We will notify you when the fix is deployed
- We ask for 90 days before public disclosure to allow time to remediate

## Out of Scope

- Denial of service attacks
- Social engineering
- Issues in third-party services (Discogs, Neo4j Aura, AWS)
