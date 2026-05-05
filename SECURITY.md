# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| main    | ✅        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a security vulnerability, please email: **macamp0328@gmail.com**

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

## Disclosure Policy

- We will acknowledge receipt of your report within 48 hours
- We will confirm the issue and communicate a timeline for a fix
- We will notify you when the fix is deployed
- We ask for 90 days before public disclosure to allow time to remediate

## Out of Scope

- Denial of service attacks
- Social engineering
- Issues in third-party services (Discogs, Neo4j Aura, AWS)
