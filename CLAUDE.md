# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# liner-notes — Agent Handbook

## Project Summary

**liner-notes** is a personal, open-source, forkable monorepo for exploring a vinyl record collection through a graph database. It pulls a Discogs collection into Neo4j and exposes a REST API for relationship-driven queries: who played bass on this record, what else was recorded at that studio, which artists appear across the most records. The name references the liner notes inside record sleeves — the credits, studios, session musicians, and producers that document the web of relationships behind every record.

---

## Common Commands

All commands run from the **repo root** unless noted.

```bash
# Local dev (Neo4j + graph-service)
docker-compose up

# Dev server only (hot-reload) — requires Neo4j already running (see .env.example for NEO4J_URI/USER/PASSWORD)
pnpm --filter graph-service dev

# Hooks (auto-installed on pnpm install via husky):
#   pre-commit  — prettier via lint-staged (runs on every commit, staged files only)
#   pre-push    — lint + typecheck + test:unit (runs before every push)
# Commit message format is not enforced — the repo squash-merges into main, so
# the PR title is what lands in history, not individual branch commits.

# Tests
pnpm --filter graph-service test              # all tests
pnpm --filter graph-service test:unit         # unit only
pnpm --filter graph-service test:integration  # integration only (needs Neo4j)
pnpm --filter graph-service test:unit:coverage

# Run a single test file
pnpm --filter graph-service exec vitest run tests/unit/ingestion/transforms.test.ts

# Build
pnpm --filter graph-service build

# Generate OpenAPI docs
pnpm --filter graph-service docs:generate

# Architecture diagrams (Inframap + Mermaid).
#   Mac local: `brew install inframap` and ensure Docker Desktop is running.
#   The script renders SVG via a pinned Docker image (nshine/dot:2.40.1) so
#   the output is byte-identical between Mac and CI — no graphviz version
#   drift, no "every PR re-renders the SVG" churn.
pnpm diagrams:generate
# Outputs:
#   infra/diagrams/resource-graph.svg   — auto-generated, every AWS resource + dependency
#   infra/diagrams/per-file/<name>.mmd  — auto-generated, one per .tf file
#   infra/diagrams/request-flow.mmd     — hand-maintained logical flow (source of truth)
# The script also inlines request-flow.mmd into the README and the runbook
# between <!-- diagrams:request-flow:start --> / :end markers.
# CI auto-regenerates on PRs touching infra/terraform/** — see .github/workflows/diagrams.yml.
```

**CI is the last wall of defense, not the first.** Any code change touching production code must pass `test:unit` locally before commit. Broken tests discovered in CI = a wasted cycle.

---

## Monorepo Structure

```
liner-notes/
├── CLAUDE.md                    ← you are here
├── .mise.toml                   ← pins Node, pnpm, terraform, kubectl, helm, gh, aws-cli
├── .github/
│   ├── dependabot.yml
│   ├── pull_request_template.md ← PR checklist for agents
│   └── workflows/
│       ├── ci.yml               ← runs on every PR
│       ├── deploy.yml           ← runs on merge to main
│       └── diagrams.yml         ← regenerates architecture diagrams on infra changes
├── scripts/
│   ├── explore-discogs.ts
│   ├── discogs-api-notes.md
│   └── diagrams/                ← `pnpm diagrams:generate` — Inframap + per-file Mermaid
├── services/
│   └── graph-service/           ← Fastify REST API + Neo4j ingestion
│       ├── CLAUDE.md            ← service-specific handbook (read this too)
│       ├── src/
│       │   ├── api/             ← route handlers
│       │   ├── db/              ← Neo4j driver + repository layer
│       │   ├── ingestion/       ← Discogs ingestion pipeline
│       │   ├── enrichment/      ← lyrics / originalYear / artist enrichment
│       │   └── index.ts         ← Fastify entry point
│       ├── tests/
│       │   ├── unit/
│       │   ├── integration/
│       │   └── fixtures/        ← sample JSON responses for tests
│       └── Dockerfile
├── infra/
│   ├── terraform/               ← AWS resources
│   ├── k8s/                     ← Kubernetes manifests
│   └── diagrams/                ← request-flow.mmd (hand) + resource-graph.svg + per-file/ (auto)
├── docker-compose.yml           ← local: Neo4j + graph-service
└── .env.example                 ← all env vars documented, no values
```

**What lives where:**

- Application code → `services/{service-name}/src/`
- Shared infra → `infra/terraform/`
- K8s manifests → `infra/k8s/{service-name}/`
- One-off scripts → `scripts/`
- Each service owns its `Dockerfile`, `.env.example`, `CLAUDE.md`

---

## graph-service Architecture

`graph-service` is the only service that talks to Neo4j. Three-layer architecture:

```
Route handler (src/api/) → Repository (src/db/) → Neo4j driver (src/db/client.ts)
```

**Key source files:**

| File                              | Purpose                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `src/server.ts`                   | Fastify instance builder, plugin registration                    |
| `src/db/schema.ts`                | Idempotent constraint/index application on startup               |
| `src/ingestion/transforms.ts`     | Pure parsing functions — no I/O, fully unit-testable             |
| `src/ingestion/discogs-client.ts` | Rate-limited Discogs HTTP client (60 req/min, 429 backoff)       |
| `src/ingestion/ingest.ts`         | Pipeline orchestrator; auto-triggers on empty graph              |
| `src/db/ingestion-repository.ts`  | All Cypher MERGE writes                                          |
| `src/enrichment/`                 | Post-ingest lyrics, originalYear, artist genre/profile pipelines |

**Ingestion fires async** (`void runIngestion(...)`) — it does not block `onReady`, so the HTTP server starts immediately while ingestion runs in the background.

### Non-Obvious Decisions

- **Track MERGE key:** `(position, releaseDiscogsId)` stored as node properties. No unique constraint on Track — "A1" appears on thousands of releases. Changing these properties orphans existing Track nodes on re-ingest.
- **Musicians with `id === 0`:** merged by `{name}` only (no `discogsId`). These are uncatalogued people in Discogs. Do not change to merge by ID.
- **Studio filter:** uses numeric `entity_type` codes `"23"` (Recorded At) and `"27"` (Mixed At) — not `entity_type_name`, which is inconsistently formatted.
- **`CREDITED_ON` scope:** `"release"` when musician → Release, `"track"` when musician → Track. Stored as property for query convenience; explore-by-musician queries depend on it.
- **`anv` → `creditedAs`:** when `extraartists[n].anv` is non-empty, stored as `creditedAs` on `CREDITED_ON`. Captures sleeve credits where an artist used a different name.
- **`formats[].qty` is a string** in the Discogs API — always `parseInt` before storing.
- **Track `duration` is frequently `""`** — treat as null, do not store.
- **`basic_information` in collection responses is incomplete** — always fetch the full release via `GET /releases/{id}`.

For the full graph schema (node labels, relationship types, constraints, API endpoints), read [`services/graph-service/CLAUDE.md`](services/graph-service/CLAUDE.md).

---

## Section 4 — Conventions & Tooling (All Locked)

### 4.1 Runtime & Framework

| Decision        | Value                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | TypeScript — strict mode                                                                                                                             |
| Runtime         | Node.js v22.x LTS                                                                                                                                    |
| Package manager | pnpm (workspaces)                                                                                                                                    |
| Tool manager    | mise — `.mise.toml` pins all toolchain versions. Run `mise install` once after cloning.                                                              |
| HTTP framework  | Fastify                                                                                                                                              |
| Test runner     | Vitest                                                                                                                                               |
| Linter          | ESLint with TypeScript plugin + `eslint-plugin-security`                                                                                             |
| Formatter       | Prettier                                                                                                                                             |
| Module system   | ESM — `"type": "module"` on all services, `module: NodeNext` + `moduleResolution: NodeNext`; `.js` extensions required on all local/relative imports |

**Agent note:** Agents run on the Mac host, not in any container. Ensure `mise install` has been run and mise is activated (`eval "$(mise activate zsh)"`).

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
- Commit messages aren't enforced; write whatever helps the reviewer

**Agent git workflow (every task):**

```bash
git fetch origin
git checkout -b task/{n}-{description} origin/main
# ... commit incrementally ...
git push -u origin task/{n}-{description}
gh pr create --title "task/{n}: {description}" --body "..."
```

**Parallel work with worktrees** (worktrees live inside the repo):

```bash
git worktree add .claude/worktrees/task-2-discogs-exploration task/2-discogs-exploration
```

Agents own all git operations — branch creation, commits, opening the PR. Miles only reviews and merges.

### 4.3 Secrets Management

| File                | Committed?         | Purpose                                 |
| ------------------- | ------------------ | --------------------------------------- |
| `.env.example`      | ✅ Yes             | Documents all variables, no values      |
| `.env.local`        | ❌ No (gitignored) | Local development values                |
| AWS Secrets Manager | N/A                | Production secrets at container startup |

**Never commit real values. CI runs TruffleHog on every PR.**

### 4.4 Code Style

- Prettier formats everything — formatter wins, no debates
- ESLint enforces quality — zero warnings/errors (max-warnings 0)
- No `any` types unless justified with an inline comment
- All async functions use `async/await` — no raw Promise chains
- Explicit return types on all exported functions

### 4.5 Coverage Thresholds

Enforced by `services/graph-service/vitest.config.ts`:

| Metric     | Threshold                                                                  |
| ---------- | -------------------------------------------------------------------------- |
| Lines      | 70%                                                                        |
| Functions  | 70%                                                                        |
| Branches   | 65% (vitest 4.x / vite 6.x counts more branch types than v8 in vitest 2.x) |
| Statements | 70%                                                                        |

---

## Service Communication

```
collection-mcp → graph-service REST API (/api/v1/*)
```

No service talks to Neo4j directly except `graph-service`.

---

## CI Requirements

**Fast-fail chain:** `format`, `lint`, `typecheck` run first in parallel → `tests-and-coverage` + `schema-validation` → `docker-build`. The following jobs run independently of this chain on every PR: `audit`, `secrets-scan`, `codeql`.

| Check             | Tool                                   | Requirement                            |
| ----------------- | -------------------------------------- | -------------------------------------- |
| Format check      | Prettier                               | Zero differences                       |
| Linting           | ESLint + security plugin               | Zero warnings/errors                   |
| Type checking     | TypeScript strict (src + tests)        | Zero errors                            |
| Tests & Coverage  | Vitest + coverage-v8 + Neo4j container | All tests pass; thresholds met         |
| Schema validation | tsx + Neo4j container                  | Constraints/indexes apply idempotently |
| Docker build      | Docker Buildx                          | Image builds successfully              |
| Security audit    | `pnpm audit`                           | No high/critical vulnerabilities       |
| Secrets scan      | TruffleHog                             | No credentials in committed code       |
| CodeQL scan       | GitHub CodeQL (security-extended)      | No security alerts                     |

---

## Deployment Overview

```
Internet
    │
[Cloudflare DNS + bot protection]  ← future sprint
    │
[EC2 t3.small — k3s single-node Kubernetes]
    └── graph-service Pod

[Neo4j Aura Free]       — external managed database
[AWS ECR]               — container registry
[AWS Secrets Manager]   — runtime secrets
[AWS CloudWatch]        — logs + alerts
```

**k3s** on EC2 t3.small instead of EKS (~$72/month). EC2 Scheduler provides scale-to-zero (~$0/month when stopped). t3.micro (1 GB) thrashes under k3s + ESO + graph-service; see [`infra/terraform/variables.tf`](infra/terraform/variables.tf) for the sizing rationale.

Operator-facing deploy, redeploy, and recovery procedures live in [`infra/RUNBOOK.md`](infra/RUNBOOK.md).

---

## Adding a New Service

1. Create `services/{service-name}/`
2. Add `Dockerfile`, `.env.example`, `CLAUDE.md`, `package.json`, `tsconfig.json`
3. Add `src/index.ts` as entry point
4. Register in `pnpm-workspace.yaml` (already covered by `services/*` glob)
5. Add K8s manifests to `infra/k8s/{service-name}/`
6. Add AWS resources to `infra/terraform/modules/{service-name}/`
7. Update root `docker-compose.yml`

---

## Public Repo Safety Rules

Repo is private but treat it as public from day one:

- No secrets in committed files — ever
- No hardcoded usernames or personal data (use `DISCOGS_USERNAME` env var)
- No AWS account IDs or ARNs in Terraform or code
- No API keys anywhere in git history
- `.env.local` and `*.tfstate` must stay gitignored

---

## Agent Guidance Philosophy

Specs here are **architectural guides**, not rigid requirements. Agents are expected to:

- Research and self-discover (Discogs API docs, Neo4j best practices, Fastify ecosystem)
- Propose improvements, flag tradeoffs, explain deviations
- **Never silently do something different** — surface alternatives before implementing
- **Own all git operations** for their task (branch, commits, PR)
