# liner-notes — Agent Handbook

## Project Summary

**liner-notes** is a personal, open-source, forkable monorepo for exploring a vinyl record collection through a graph database. It pulls a Discogs collection into Neo4j and exposes a REST API for relationship-driven queries: who played bass on this record, what else was recorded at that studio, which artists appear across the most records. The name references the liner notes inside record sleeves — the credits, studios, session musicians, and producers that document the web of relationships behind every record.

---

## Monorepo Structure

```
liner-notes/
├── CLAUDE.md                    ← you are here
├── README.md
├── SECURITY.md
├── LICENSE
├── .devcontainer/
│   └── devcontainer.json        ← VS Code / Codespaces dev environment
├── .github/
│   └── workflows/
│       ├── ci.yml               ← runs on every PR
│       └── deploy.yml           ← runs on merge to main (Task 5)
├── scripts/
│   ├── explore-discogs.ts       ← Task 2: Discogs API exploration
│   └── discogs-api-notes.md     ← Task 2: API findings
├── services/
│   └── graph-service/           ← Fastify REST API + Neo4j ingestion
│       ├── CLAUDE.md            ← service-specific agent handbook
│       ├── src/
│       │   ├── api/             ← route handlers
│       │   ├── db/              ← Neo4j driver + repository layer
│       │   ├── ingestion/       ← Discogs ingestion pipeline
│       │   ├── enrichment/      ← lyrics enrichment (LRCLIB / Genius)
│       │   └── index.ts         ← Fastify server entry point
│       ├── tests/
│       │   ├── unit/
│       │   ├── integration/
│       │   └── fixtures/        ← sample JSON responses for tests
│       ├── Dockerfile
│       └── package.json
├── infra/
│   ├── terraform/               ← AWS resources (Task 5)
│   └── k8s/                     ← Kubernetes manifests (Task 5)
├── docker-compose.yml           ← local: Neo4j + graph-service
├── .env.example                 ← all env vars documented, no values
├── package.json                 ← pnpm workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

**What lives where:**

- Application code → `services/{service-name}/src/`
- Shared infra (VPC, ECR, IAM) → `infra/terraform/`
- Service K8s manifests → `infra/k8s/{service-name}/`
- One-off scripts → `scripts/`
- Each service owns its `Dockerfile`, `.env.example`, `CLAUDE.md`

---

## Section 4 — Conventions & Tooling (All Locked)

### 4.1 Runtime & Framework

| Decision        | Value                         |
| --------------- | ----------------------------- |
| Language        | TypeScript — strict mode      |
| Runtime         | Node.js v22.x LTS             |
| Package manager | pnpm (workspaces)             |
| HTTP framework  | **Fastify**                   |
| Test runner     | Vitest                        |
| Linter          | ESLint with TypeScript plugin |
| Formatter       | Prettier                      |
| Module system   | ESM — `"type": "module"` on all services, `module: NodeNext` + `moduleResolution: NodeNext` in tsconfig; `.js` extensions on imports are required, not optional |

**Why Fastify over Express:** Native TypeScript support, built-in JSON schema validation, `@fastify/swagger` + `@fastify/swagger-ui` for zero-friction OpenAPI docs (hard requirement), and a cleaner plugin architecture.

### 4.2 Git Conventions

**Branch naming:**

| Branch type    | Pattern                        | Created by     |
| -------------- | ------------------------------ | -------------- |
| Agent tasks    | `task/{n}-{short-description}` | Agent          |
| Human features | `feat/{short-description}`     | Miles          |
| Fixes          | `fix/{short-description}`      | Agent or Miles |
| Docs/config    | `chore/{short-description}`    | Agent or Miles |

**Rules:**

- `main` is protected — no direct commits ever
- All changes via PR with CI passing
- Squash merge into `main` — one clean commit per task
- Conventional Commits on all commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- Branches are short-lived — complete task, open PR, done

**Agent git workflow (every task):**

```bash
# 1. Start from latest main
git fetch origin
git checkout -b task/{n}-{description} origin/main

# 2. Commit incrementally
git add .
git commit -m "feat: add health endpoint"

# 3. Push and open PR
git push -u origin task/{n}-{description}
gh pr create --title "task/{n}: {description}" --body "..."
```

**Parallel work with worktrees:**

```bash
git worktree add ../liner-notes-task-2 task/2-discogs-exploration
git worktree add ../liner-notes-task-3 task/3-neo4j-connection
```

Each worktree is a fully independent working directory on its own branch. **Agents own all git operations** — branch creation, commits, opening the PR. Miles only reviews and merges.

### 4.3 Secrets Management

| File                | Committed?         | Purpose                                 |
| ------------------- | ------------------ | --------------------------------------- |
| `.env.example`      | ✅ Yes             | Documents all variables, no values      |
| `.env.local`        | ❌ No (gitignored) | Local development values                |
| AWS Secrets Manager | N/A                | Production secrets at container startup |

**Never commit real values. CI runs a secrets scan (TruffleHog) on every PR.**

`.gitignore` covers: `.env`, `.env.local`, `.env.*.local`, `.env.production`

### 4.4 Code Style

- Prettier handles all formatting — formatter wins, no style debates
- ESLint handles code quality — zero warnings/errors required in CI
- No `any` types unless justified with an inline comment
- All async functions use `async/await` — no raw Promise chains
- Explicit return types on all exported functions

**Agent requirement — run before every commit:**

```bash
pnpm prettier --check .          # formatting must pass
pnpm --filter graph-service lint # ESLint must pass (zero warnings/errors)
pnpm --filter graph-service typecheck # TypeScript strict must pass
```

Formatting and lint errors that slip through to PR review are agent mistakes, not reviewer catches. Run these locally before opening a PR. CI enforces them as hard gates — fix before pushing, not after.

---

## Service Communication

Services communicate via REST API only:

```
collection-mcp → graph-service REST API (/api/v1/*)
```

No service talks to Neo4j directly except `graph-service`. `graph-service` is the single data access layer for the graph.

---

## CI Requirements

All 8 checks must pass before a PR is mergeable:

| Check             | Tool                      | Requirement                         |
| ----------------- | ------------------------- | ----------------------------------- |
| Linting           | ESLint                    | Zero warnings or errors             |
| Type checking     | TypeScript strict         | Zero errors                         |
| Unit tests        | Vitest                    | 70% coverage minimum                |
| Integration tests | Fastify inject()          | 100% of API routes covered          |
| Docker build      | Docker                    | Image builds successfully           |
| Schema validation | Custom script             | Constraints + indexes apply cleanly |
| Security scan     | `pnpm audit` + Dependabot | No critical vulnerabilities         |
| Secrets scan      | TruffleHog                | No credentials in committed code    |

---

## Deployment Overview

```
Internet
    │
[Cloudflare DNS + bot protection]  ← future sprint
    │
[EC2 t3.micro — k3s single-node Kubernetes]
    └── graph-service Pod

[Neo4j Aura Free]       — external managed database
[AWS ECR]               — container registry
[AWS Secrets Manager]   — runtime secrets
[AWS CloudWatch]        — logs + alerts
```

**k3s:** Lightweight certified Kubernetes as a single binary on EC2 t3.micro. Supports all standard K8s manifests. Chosen over EKS (~$72/month) for this project's scale.

**Scale-to-zero:** EC2 Scheduler stops the instance on a schedule and restarts on demand (~$0/month when stopped).

---

## Adding a New Service

1. Create `services/{service-name}/`
2. Add `Dockerfile`, `.env.example`, `CLAUDE.md`, `package.json`, `tsconfig.json`
3. Add `src/index.ts` as entry point
4. Register the service in `pnpm-workspace.yaml` (already covered by `services/*`)
5. Add K8s manifests to `infra/k8s/{service-name}/`
6. Add service-specific AWS resources to `infra/terraform/modules/{service-name}/`
7. Update root `docker-compose.yml` for local development

---

## Public Repo Safety Rules

The repo is currently private but will be made public on first stable release. Treat it as public from day one:

- **No secrets in committed files** — ever. Use `.env.example` for documentation, `.env.local` for values.
- **No hardcoded usernames or personal data** — use environment variables for `DISCOGS_USERNAME` and similar.
- **No AWS account IDs or resource ARNs** in committed Terraform or code.
- **No API keys, tokens, or passwords** anywhere in the git history.
- Before any commit: verify `.env.local` and `*.tfstate` are gitignored.
- CI TruffleHog scan is a hard gate — it runs on every PR.

---

## Agent Guidance Philosophy

Specs in this codebase are **architectural guides**, not rigid requirements. Agents are expected to:

- Treat schema and API specs as the intended direction
- Research and self-discover (Discogs API docs, Neo4j best practices, Fastify ecosystem)
- Propose improvements, flag tradeoffs, explain deviations
- **Never silently do something different** — surface alternatives before implementing
- **Own all git operations** for their task (branch, commits, PR)
