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
#   pre-commit  — blocks commits on main, then prettier via lint-staged (staged files only)
#   pre-push    — blocks pushes targeting main, then lint + typecheck + test:unit:coverage
# Install is guarded by scripts/prepare.sh: `pnpm install` now FAILS LOUDLY if husky
# can't wire the hooks (no more silent `|| true`), and skips cleanly when there's no
# .git (Docker build) or CI/HUSKY=0 is set. Guard logic is tested: `pnpm prepare:test`.
# Commit message format is not enforced — the repo squash-merges into main, so
# the PR title is what lands in history, not individual branch commits.

# One-shot local gauntlet — run before pushing. Covers the offline half of the CI
# fan-out: prettier --check → markdownlint → lint → typecheck → unit coverage →
# scripts:test. (yamllint/tflint stay CI-only — external Python/binary tools.)
pnpm verify

# Doc/config/Terraform lint gates (CI re-runs all three — see CI Requirements).
# markdownlint is a devDependency (also part of `pnpm verify`); yamllint/tflint are
# CI-pinned (no package.json entry) with the local fallbacks shown.
pnpm markdownlint                              # Markdown structure (config: .markdownlint-cli2.jsonc)
pipx run yamllint==1.38.0 --format github .    # YAML semantics (config: .yamllint.yaml)
# tflint (Terraform lint + AWS ruleset, config: .tflint.hcl): install tflint, then
#   tflint --init && tflint --chdir=infra/terraform && tflint --chdir=infra/terraform/bootstrap

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

# Insomnia collection (committed: services/graph-service/docs/insomnia.collection.yaml).
# Chains docs:generate → scripts/insomnia/generate.ts → prettier, refreshing BOTH
# committed API artifacts (openapi.json + the Insomnia v5 YAML) from the live
# route definitions. Deterministic (hashed ids, no timestamps) and self-validated
# on every run. Regenerate locally and commit after ANY route/schema change —
# .github/workflows/insomnia.yml re-runs it on PRs touching
# services/graph-service/src/** and FAILS the check on drift (same fail-on-drift
# rationale as diagrams.yml). This doubles as the drift guard for openapi.json.
# Forks: set PROD_API_URL (env) to override the Production sub-environment URL,
# and add the same value as a GitHub repo variable so CI regenerates with it.
pnpm insomnia:generate

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
# CI re-runs the generator on PRs touching infra/terraform/** and FAILS if the
# committed diagrams differ — regenerate locally and commit before pushing.
# See .github/workflows/diagrams.yml.

# Changelog (plain-English, AI-written, VERSIONED, self-healing). See scripts/changelog/README.md.
# A release is cut AUTOMATICALLY on every successful Deploy (workflow_run): approving the
# production deploy gate cuts a `vYYYY.MM.DD` release of everything merged since the last one,
# tagged at the DEPLOYED commit. Merged PRs accumulate in a rolling "unreleased" DRAFT until that
# deploy. A manual fallback exists — `changelog:release` (Actions "Run workflow", or locally) — and
# a cut with nothing pending is a no-op. Note richness ramps with an importance tier
# (maintenance/standard/notable). NOT committed files, NOT a PR check; tag refs can't retrigger
# branch-filtered CI. CAVEAT: Deploy is PATH-FILTERED (services/infra/lockfile/etc.), so a batch of
# only docs/scripts/CI changes never deploys and never auto-cuts — it rides the next deployable
# merge, or use the manual fallback. (Auto-cut is also gated to main deploys.)
pnpm changelog:test                            # unit tests (scripts/changelog/*.test.ts)
pnpm changelog:update 304                      # summarise one PR by number (also refreshes it)
pnpm changelog:backfill                        # seed history (also upgrades PR-title fallbacks)
pnpm changelog:backfill --refresh              # re-summarise every entry (e.g. after style.md edits)
pnpm changelog:reconcile --since 2026-06-01    # heal missed PRs + re-render published releases (no AI)
pnpm changelog:release                         # manual fallback cut (auto-cuts on deploy; tags main HEAD, HEAD_SHA to pin)
pnpm changelog:baseline                        # one-shot: publish the v0.1.0 history baseline
# Local runs auto-load ANTHROPIC_API_KEY from .env.local/.env (no export needed).
```

### Changelog

The changelog is **data, not prose**: a `changelog.jsonl` store (one record per PR, keyed by
number, with a `version` = its CalVer tag or null) plus a `versions.json` manifest (one record per
cut version), both attached as assets on the `unreleased` **draft** release. Everything
human-facing is a deterministic `render()` of that store — `renderUnreleased` (draft preview),
`renderVersion` (each published release, tier-aware), `renderBaseline` (the v0.1.0 history). **Three
writers** keep it current: the per-merge hook
([`.github/workflows/changelog.yml`](.github/workflows/changelog.yml), `changelog:update`); **the cut**
([`.github/workflows/changelog-release.yml`](.github/workflows/changelog-release.yml)) — fired
**automatically on every successful Deploy** (`workflow_run`; the production deploy gate is the manual
approval, so an approved deploy cuts a `vYYYY.MM.DD` release of everything merged since the last one,
tagged at the deployed commit), with `workflow_dispatch`/`changelog:release` as a manual fallback;
and a weekly self-healing reconciler
([`.github/workflows/changelog-reconcile.yml`](.github/workflows/changelog-reconcile.yml)) that fills
gaps and **re-renders every published release from the frozen store with no new AI calls**.
Summaries come from Claude via structured outputs (up to two sentences; default `claude-opus-4-8`,
`CHANGELOG_MODEL=claude-haiku-4-5` for cost), with a PR-title fallback when `ANTHROPIC_API_KEY` is
unset so the merge path never fails. **One-time setup:** `gh secret set ANTHROPIC_API_KEY`,
`pnpm changelog:backfill` to seed history, then `pnpm changelog:baseline` once before the first
cut. Full details in [`scripts/changelog/README.md`](scripts/changelog/README.md).

### When to refresh diagrams

Two distinct workflows; pick the right one for the change you're making.

**Regenerate locally before pushing.** Any change under `infra/terraform/**` requires running `pnpm diagrams:generate` locally and committing the updated `resource-graph.svg` and `per-file/*.mmd` files alongside your terraform change. [`.github/workflows/diagrams.yml`](.github/workflows/diagrams.yml) re-runs the generator on every same-paths PR and **fails the check** if the committed artifacts don't match — same generator, same pinned graphviz image (`nshine/dot:2.40.1`), byte-identical output. The workflow used to auto-commit the regenerated files, but pushes from the default `GITHUB_TOKEN` don't trigger downstream workflows (GitHub anti-recursion rule), which left the PR's actual HEAD with no CI run and branch protection blocking the merge. Fail-on-drift trades one local command for a clean check rollup.

**Needs a manual edit.** The hand-maintained logical flow at [`infra/diagrams/request-flow.mmd`](infra/diagrams/request-flow.mmd) is _not_ derived from Terraform — CI will never update it. Edit it directly (or use the `/diagrams draft` skill, which walks the diff with current infra context) after any of the following:

- A new external service joins or leaves the runtime path (e.g. adding Cloudflare in front of the NodePort, swapping Aura for self-hosted Neo4j).
- The ingress path changes (NodePort → ALB, new domain, mTLS termination moving).
- A new in-cluster component appears that the reader needs to understand (e.g. an ingress controller, a sidecar, a new namespace).
- Auth or secrets mechanics shift (e.g. IRSA instead of IMDS-via-instance-role, a new CronJob inserted in the secret loop).
- A new heavy-traffic data path enters or leaves the picture (e.g. ingesting from a second upstream API).

After editing `request-flow.mmd`, run `pnpm diagrams:generate` so the inlined copies in [`README.md`](README.md) and [`infra/RUNBOOK.md`](infra/RUNBOOK.md) update between their marker comments.

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
│       ├── diagrams.yml         ← regenerates architecture diagrams on infra changes
│       ├── insomnia.yml         ← regenerates openapi.json + Insomnia collection; fails on drift
│       ├── changelog.yml        ← per-merge plain-English changelog updater
│       └── changelog-reconcile.yml ← weekly self-healing changelog backfill
├── docs/                        ← adr/ (architecture decision records)
├── scripts/
│   ├── explore-discogs.ts
│   ├── discogs-api-notes.md
│   ├── diagrams/                ← `pnpm diagrams:generate` — Inframap + per-file Mermaid
│   ├── changelog/               ← `pnpm changelog:*` — AI-written release notes
│   ├── insomnia/                ← `pnpm insomnia:generate` — Insomnia collection generator
│   └── admin/                   ← operator shell helpers: get.sh/post.sh (admin HTTP), power.sh, mint-deploy-kubeconfig.sh
├── services/
│   └── graph-service/           ← Fastify REST API + Neo4j ingestion
│       ├── CLAUDE.md            ← service-specific handbook (read this too)
│       ├── src/
│       │   ├── api/             ← route handlers
│       │   ├── db/              ← Neo4j driver + repository layer
│       │   ├── ingestion/       ← Discogs ingestion pipeline
│       │   ├── enrichment/      ← post-ingest enrichment (lyrics, master-data, nationality, track audio, artist genres/profiles/Wikidata bio)
│       │   ├── observability/   ← stats snapshots + Aura keep-warm timer
│       │   ├── server.ts        ← Fastify instance builder
│       │   └── index.ts         ← Fastify entry point
│       ├── tests/
│       │   ├── unit/
│       │   ├── integration/
│       │   ├── route/           ← per-route API tests
│       │   ├── load/            ← load / perf checks
│       │   ├── helpers/         ← cross-suite test utilities
│       │   └── fixtures/        ← sample JSON responses for tests
│       ├── docs/                ← committed openapi.json + insomnia.collection.yaml (`pnpm insomnia:generate`)
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

| File                                  | Purpose                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server.ts`                       | Fastify instance builder, plugin registration                                                                                                    |
| `src/db/schema.ts`                    | Idempotent constraint/index application on startup                                                                                               |
| `src/ingestion/transforms.ts`         | Pure parsing functions — no I/O, fully unit-testable                                                                                             |
| `src/ingestion/rate-limited-fetch.ts` | `createRateLimitedFetch` — shared retry/backoff/spacing core for the 5 API clients                                                               |
| `src/ingestion/discogs-client.ts`     | Rate-limited Discogs HTTP client (60 req/min, 429 backoff)                                                                                       |
| `src/ingestion/ingest.ts`             | First-5-stage pipeline (`runIngestion`) + shared `ingestReleases`                                                                                |
| `src/ingestion/stages.ts`             | `RELOAD_STAGES` — full reload sequence + per-stage `deps`/`resources`                                                                            |
| `src/ingestion/scheduler.ts`          | `scheduleStages` — generic dependency/resource-aware concurrent scheduler                                                                        |
| `src/ingestion/orchestrator.ts`       | `runReload` — drives the scheduler, DB-checkpointed, resumable                                                                                   |
| `src/db/job-repository.ts`            | `ReloadJob`/`ReloadStage` persistence (checkpoint/resume)                                                                                        |
| `src/db/ingestion-repository.ts`      | All Cypher MERGE writes                                                                                                                          |
| `src/enrichment/`                     | Post-ingest enrichment: lyrics, master-data (originalYear), nationality, track audio (MusicBrainz/AcousticBrainz/Deezer), artist genres/profiles |

**Ingestion fires async** (`void runIngestion(...)`) — it does not block `onReady`, so the HTTP server starts immediately while ingestion runs in the background.

**Orchestrated reload (#175).** `POST /api/v1/admin/reload` runs the **full** sequence (ingest + every enrichment, including the track-level/nationality stages) as one job whose per-stage state is **persisted to Neo4j**, so a pod killed mid-reload **resumes from where it left off** on restart instead of restarting or silently abandoning the load. The legacy `POST /admin/ingest` + empty-graph auto-trigger remain a first-5-stage, in-memory safety net. The reload does not wipe (run `POST /admin/reset?confirm=wipe-all` first). See [`services/graph-service/CLAUDE.md`](services/graph-service/CLAUDE.md) → "Orchestrated Reload".

**Smarter reload scheduling (#176).** Stages no longer run strictly sequentially: `runReload` drives a generic, dependency- and resource-aware scheduler (`scheduler.ts`) with **bounded concurrency** (`RELOAD_STAGE_CONCURRENCY`, default 2). Cheap + #165-gate stages (`master-data`, `artist-profiles`, the pure-Cypher ones) lead and overlap the slow `lyrics`/`track-musicbrainz`, so the gate metrics reach threshold in minutes. `deps` enforce ordering (e.g. `mb-release-events` after `master-data`; acoustic/deezer after `track-musicbrainz`) and `resources` lanes enforce exclusion (shared API rate limiters; a `track` lane serialising the batched Track writers — per-node `lyrics` is exempt). See [`services/graph-service/CLAUDE.md`](services/graph-service/CLAUDE.md) → "Scheduling (#176)".

### Non-Obvious Decisions

- **Track MERGE key:** `(position, releaseDiscogsId)` stored as node properties. No unique constraint on Track — "A1" appears on thousands of releases. Changing these properties orphans existing Track nodes on re-ingest.
- **Musicians with `id === 0`:** merged by `{name}` only (no `discogsId`). These are uncatalogued people in Discogs. Do not change to merge by ID.
- **Studio filter:** uses numeric `entity_type` codes `"23"` (Recorded At) and `"27"` (Mixed At) — not `entity_type_name`, which is inconsistently formatted.
- **`CREDITED_ON` scope:** `"release"` when musician → Release, `"track"` when musician → Track. Stored as property for query convenience; explore-by-musician queries depend on it.
- **`anv` → `creditedAs`:** when `extraartists[n].anv` is non-empty, stored as `creditedAs` on `CREDITED_ON`. Captures sleeve credits where an artist used a different name.
- **`instrument` is derived, not raw (#333):** `parseInstrument(role)` normalizes the Discogs role onto a controlled vocabulary and is stored as a **separate** `CREDITED_ON` property; the raw `role`/`displayRole` are kept verbatim. Derived independently of `roleCategory` (gating on `performer` would drop trombone/viola/clarinet, which bucket as `other`); `null` for non-instrument roles. Backs `/api/v1/explore/instrument/:name`.
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

## Issue Organization

Claude Code creates most issues here, so they're labeled automatically with a **four-axis namespaced taxonomy**. The full label list, the priority rule, and the bookmark queries live in [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md); the rationale (and the features we deliberately skipped) is in [ADR 0002](docs/adr/0002-issue-organization.md).

- **Status** — `needs-triage` · `needs-info` · `ready-for-agent` · `ready-for-human` · `wontfix`, plus the `blocked` modifier (depends on an open issue).
- **Area** — one `area:*` per component: `ingestion` · `enrichment` · `graph` · `api` · `infra` · `ci` · `scripts` · `docs`.
- **Type** — `enhancement` · `bug` · `refactor` · `chore` (+ `good first issue`).
- **Priority** — `priority:high|medium|low` (high = keystone-that-unblocks or prod bug; low = nice-to-have / measure-first; medium = default).

**Auto-apply rule:** every issue Claude Code creates gets exactly one status + area + type + priority (plus `blocked` when a `## Blocked by #N` references an open issue). Agent-safe, fully-specified work is born `ready-for-agent`; anything needing a maintainer judgment call is born `needs-triage`.

**Pick the next task** (instead of scanning the backlog): open `is:open label:"ready-for-agent" label:"priority:high" -label:"blocked"`, falling back to the full FIFO queue `is:open label:"ready-for-agent" -label:"blocked" sort:created-asc` → hand the top item's URL to `/issue`.

### Agent skills

The matt-pocock engineering skills (`triage`, `to-issues`, `to-prd`, `diagnose`, `tdd`) read their per-repo config from here:

- **Issue tracker** — GitHub Issues on `macamp0328/liner-notes`, via the `gh` CLI.
- **Triage labels** — the four-axis taxonomy above; full mapping in [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- **Domain docs** — single-context: this `CLAUDE.md` + `services/graph-service/CLAUDE.md` + `docs/adr/`.

---

## Service Communication

`graph-service` is currently the **only** service in the repo. The planned `collection-mcp` (not yet
built — there is no `services/collection-mcp`) will reach the graph the same way any future client
must:

```
collection-mcp (planned) → graph-service REST API (/api/v1/*)
```

No service talks to Neo4j directly except `graph-service`.

---

## Walls of Defense (Agentic Development)

The repo is built for agent-driven work, so the guardrails are layered — each wall assumes the
one before it was skipped. Don't fight them; a blocked command means fix the cause, not bypass.

| Layer               | Mechanism                                                                                                                                                                   | What it stops                                                                                                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent (Claude Code) | `.claude/hooks/bash-guard.sh` (PreToolUse) + `permissions` in `.claude/settings.json`                                                                                       | `--no-verify` hook bypasses, plain `git push --force`/`-f`; reading `.env.local`/`*.tfstate`; unprompted `terraform apply/destroy`, `kubectl delete`                                                                                                                                  |
| Local git (husky)   | `pre-commit`, `pre-push`                                                                                                                                                    | commits on `main`, pushes targeting `main`; unformatted/unlinted/untested/under-covered code reaching origin                                                                                                                                                                          |
| CI (`ci.yml` & co.) | 16-job fan-out (incl. `script-tests`, `terraform`, shellcheck, `hadolint`, `kubeconform`, `markdownlint`, `yamllint`, `tflint`) + drift guards (diagrams, insomnia/openapi) | everything above, re-checked server-side; secrets (TruffleHog), CVEs (audit), CodeQL findings; terraform fmt/validate + lint (tflint/AWS); `*.sh` lint; Dockerfile lint (hadolint); k8s manifest schemas (kubeconform); Markdown structure (markdownlint) + YAML semantics (yamllint) |
| GitHub              | branch protection + squash-merge + CODEOWNERS                                                                                                                               | direct pushes to `main`, merging with red checks, unreviewed changes                                                                                                                                                                                                                  |
| Runtime             | helmet headers, global rate limit, admin bearer auth, env validation at startup                                                                                             | missing `ADMIN_TOKEN` in production is a **startup failure**, not a silent 503 admin surface                                                                                                                                                                                          |

Notes for agents:

- `--force-with-lease` is allowed when a history rewrite is genuinely needed; plain `--force` never is.
- The pre-push coverage gate (`test:unit:coverage`) enforces the same thresholds as CI — run
  `pnpm verify` before pushing so failures surface locally, not in CI.
- The bash-guard script is dependency-free (POSIX sh + absolute-path `/usr/bin/grep`/`awk`) on
  purpose: worktrees with an untrusted `.mise.toml` lose PATH entries in subshells. Keep it that
  way. Matching is line-wise against the logical command, so commit messages that merely _mention_
  the blocked flags don't trip it.

---

## CI Requirements

**Parallel fan-out:** `format`, `lint`, `typecheck`, `tests-and-coverage`, `schema-validation`, `script-tests`, `terraform`, `hadolint`, `kubeconform`, `markdownlint`, `yamllint`, `tflint`, `audit`, `secrets-scan`, `codeql`, and `actionlint` all start in parallel at t=0 (`actionlint` also shellchecks the standalone `*.sh` scripts). `docker-build` is the only gated job — it waits on `lint` + `typecheck` (the multi-stage build compiles TS, so a type error would fail it anyway) but **not** on the ~90s test job, so it builds alongside it. There is deliberately no static fast-fail gate on the test/schema jobs: it traded ~1 min of green-path wall-clock for runner minutes that were only saved on red PRs. The critical path is still `max(tests-and-coverage, codeql)` ≈ 85s — the doc/config linters (`markdownlint`, `yamllint`, `tflint`) finish in seconds and stay well off it.

| Check             | Tool                                                   | Requirement                                                                                      |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Format check      | Prettier                                               | Zero differences                                                                                 |
| Linting           | ESLint + security plugin                               | Zero warnings/errors (src + tests + `scripts/` + service scripts + configs — see note)           |
| Markdown lint     | markdownlint-cli2 (pinned devDep)                      | High-signal structure only — heading hierarchy + in-repo links; formatting left to Prettier      |
| YAML lint         | yamllint (pinned via pipx)                             | Duplicate keys + ambiguous truthy (relaxed preset); formatting left to Prettier                  |
| Type checking     | TypeScript strict (src + tests + `scripts/` + configs) | Zero errors                                                                                      |
| Tests & Coverage  | Vitest + coverage-v8 + Neo4j container                 | All tests pass; thresholds met                                                                   |
| Schema validation | tsx + Neo4j container                                  | Constraints/indexes apply idempotently                                                           |
| Script tests      | node:test via tsx (`changelog:test`)                   | All changelog generator tests pass                                                               |
| Terraform         | `terraform fmt -check` + `validate`                    | Formatted; both roots validate (`init -backend=false`); providers lock-pinned + cached + retried |
| Terraform lint    | tflint (pinned binary) + AWS ruleset                   | Both roots clean under the `recommended` preset; no rule suppressions (`.tflint.hcl`)            |
| K8s manifests     | kubeconform (pinned, kustomize-built)                  | Manifests validate vs upstream schemas; only the 2 ESO CRD kinds `-skip`ped by name              |
| Shellcheck        | shellcheck (pinned, in `actionlint`)                   | Standalone `*.sh` clean                                                                          |
| Docker build      | Docker Buildx                                          | Image builds successfully                                                                        |
| Dockerfile lint   | hadolint (pinned binary)                               | Dockerfile passes hadolint (default rules); add `.hadolint.yaml` only to justify a needed ignore |
| Security audit    | `pnpm audit`                                           | No high/critical vulnerabilities                                                                 |
| Secrets scan      | TruffleHog                                             | No credentials in committed code                                                                 |
| CodeQL scan       | GitHub CodeQL (security-extended)                      | No security alerts                                                                               |

> **Lint scope note:** `lint`/`typecheck` are root-level (`pnpm lint` / `pnpm typecheck`), not `--filter graph-service`, so they cover `scripts/`, the service-level `scripts/`, and the vitest configs — not just `src`. Type-aware ESLint needs every file in a tsconfig: `scripts/tsconfig.json` plus `tsconfig.test.json`'s widened `include` provide that (see `.eslintrc.cjs` `overrides`). `eslint-plugin-security`'s `detect-non-literal-fs-filename` / `detect-object-injection` are scoped **off** for the trusted-path `scripts/` tooling (they target untrusted-input web handlers). **Test files are linted too** (#345): three idiomatic-noise rules — `unbound-method` (passing `obj.method` to `expect`), `require-await` (async mock signatures), `detect-object-injection` (`arr[i]` in assertions) — are tuned **off** for tests, while the correctness rules stay on. `no-floating-promises` is the load-bearing one: kept **on** for the vitest tests (a missing `await` on an async assertion is a silent false-green) and turned **off** only for the root `scripts/**/*.test.ts` node:test suite, where a top-level `test(...)` floats by design.

> **Doc/config/terraform lint (#348, #349):** `markdownlint` and `yamllint` cover the semantic/structural tail Prettier doesn't — they deliberately enable **only** high-signal rules (Markdown heading hierarchy + in-repo links; YAML duplicate-key + ambiguous truthy) and disable everything Prettier formats, so the linters never fight the formatter. `tflint` (+ AWS ruleset) adds Terraform anti-pattern/misconfig linting on top of `fmt`/`validate`. All three **hard-fail** (show red on the PR) like the sibling quality jobs (`terraform`, `hadolint`, `kubeconform`); which checks actually _block_ merge is curated in the branch-protection ruleset, not by the job existing. **Dead-link checking was deliberately skipped** — a network-dependent link checker (e.g. lychee) would make PR CI flaky for little gain, and markdownlint's MD051 already catches broken _in-repo_ anchors. A deeper Terraform **security-posture** scanner (e.g. trivy) is deferred to a follow-up issue.

> **Terraform registry resilience:** `terraform init` resolves providers from `registry.terraform.io`, which periodically times out (`context deadline exceeded`) and reds a whole batch of PRs at once. Three layered defences keep the `Terraform Validate` job green through a blip: the **committed `.terraform.lock.hcl`** in each root pins exact provider versions + checksums (deterministic, supply-chain-safe — it's the one terraform file that is _not_ `.gitignore`d); a **`TF_PLUGIN_CACHE_DIR` cache** (`actions/cache`, keyed on the lock files) skips the registry entirely on a cache hit; and the `init` steps **retry with backoff** when a download is genuinely needed (terraform's own 2 attempts aren't enough — same retry-transient-pulls rationale as the `start-neo4j` action). The lock files track `linux_amd64` (CI) + `darwin_arm64` (Apple Silicon dev); on a new platform run `terraform -chdir=<root> providers lock -platform=<os_arch>` and commit. The `tflint --init` plugin download retries the same way.

---

## Deployment Overview

```
Internet
    │  HTTPS (custom domain)
[Cloudflare — TLS termination + custom domain + origin-port rule]
    │  origin reachable ONLY from Cloudflare's IP ranges
[EC2 t3.small — k3s single-node Kubernetes]
    └── graph-service Pod (NodePort :30080)

[Neo4j Aura Free]       — external managed database
[AWS ECR]               — container registry
[AWS Secrets Manager]   — runtime secrets
[AWS CloudWatch]        — logs + alerts
```

**TLS + custom domain (#119) is live.** The production API is served over **HTTPS at a custom domain** (`ln-api.impressivelyadequate.com` for this deployment): Cloudflare proxies the hostname, terminates TLS, and an Origin Rule routes to the NodePort on `:30080` (Cloudflare's proxy can't reach a non-standard port otherwise). `restrict_app_to_cloudflare` locks the security group so the origin accepts only Cloudflare's IP ranges — direct `http://<eip>:30080` is refused. The front door is opt-in via `cloudflare_enabled` (default off, so forks start on plain HTTP until they configure a Cloudflare zone + `custom_domain`). See [`infra/terraform/cloudflare.tf`](infra/terraform/cloudflare.tf) and the "TLS + custom domain (Cloudflare)" section of [`infra/RUNBOOK.md`](infra/RUNBOOK.md).

**k3s** on EC2 t3.small instead of EKS (~$72/month). Scale-to-zero is implemented via a scheduler Lambda + EventBridge schedules ([`infra/terraform/scheduler.tf`](infra/terraform/scheduler.tf)): a nightly stop/start cost-saver plus a `pnpm power:on|off|auto|status` switch (~$0/month when stopped). It is opt-in — the nightly schedule ships DISABLED; see the "Instance power switch" section of [`infra/RUNBOOK.md`](infra/RUNBOOK.md). t3.micro (1 GB) thrashes under k3s + ESO + graph-service; see [`infra/terraform/variables.tf`](infra/terraform/variables.tf) for the sizing rationale. The Neo4j Aura Free instance auto-pauses after 72h idle; the graph-service stats-snapshot timer doubles as a keep-warm (real Cypher every 6h, capped <72h) that holds it open while the node is up — aligned to the EC2 uptime window by design, so a long `power:off` lets Aura pause as part of the same "asleep" state. See the "Keeping Aura warm" section of [`infra/RUNBOOK.md`](infra/RUNBOOK.md).

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
