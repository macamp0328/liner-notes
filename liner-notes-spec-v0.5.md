# liner-notes

## Graph Service — Product & Architecture Specification

> **Status:** Draft v0.5 — Ready for Claude Code handoff  
> **Repo:** `liner-notes` (github.com/macamp0328/liner-notes) — Private → Public on first stable release  
> **Sprint Scope:** Backend graph service only — frontends are future sprints  
> **Purpose:** Primary handoff document for agentic AI development sessions (Claude Code). Schema, API specs, and infrastructure patterns are **starting points and guides** — agents are encouraged to research, self-discover, and propose improvements. Never silently deviate; surface alternatives explicitly.

---

## Table of Contents

0. [First Steps](#0-first-steps)
1. [Project Vision & Goals](#1-project-vision--goals)
2. [Learning Objectives](#2-learning-objectives)
3. [Monorepo Structure](#3-monorepo-structure)
4. [Conventions & Tooling](#4-conventions--tooling)
5. [Agentic AI Development Setup](#5-agentic-ai-development-setup)
6. [Discogs API Integration](#6-discogs-api-integration)
7. [Neo4j Graph Schema](#7-neo4j-graph-schema)
8. [Data Ingestion Pipeline](#8-data-ingestion-pipeline)
9. [API Layer](#9-api-layer)
10. [Infrastructure & Deployment](#10-infrastructure--deployment)
11. [Testing Strategy](#11-testing-strategy)
12. [Observability & Monitoring](#12-observability--monitoring)
13. [Future Sprints](#13-future-sprints)
14. [Open Questions](#14-open-questions)
15. [Public Repo Checklist](#15-public-repo-checklist)
16. [Fork Guide](#16-fork-guide)

---

## 0. First Steps

### 0.1 Human Prerequisites ✅

These have been completed by Miles before handing off to Claude Code:

- [x] Repo name decided: **`liner-notes`**
- [x] Private GitHub repo created: `github.com/macamp0328/liner-notes`
- [x] Neo4j Aura Free instance created — URI, username, password saved
- [x] Discogs personal access token generated
- [x] AWS account confirmed, IAM user created with policies:
  - `AmazonEC2FullAccess`
  - `AmazonEC2ContainerRegistryFullAccess`
  - `AmazonVPCFullAccess`
  - `SecretsManagerReadWrite`
  - `aws configure` completed locally
- [x] Docker Desktop installed and running
- [x] Node.js v22.x installed (via nvm)
- [x] pnpm installed globally
- [x] VS Code + Dev Containers extension installed
- [x] Repo cloned locally: `git clone git@github.com:macamp0328/liner-notes.git`

---

### 0.2 Agent Task 1 — Monorepo Scaffold

**Goal:** Create the full monorepo skeleton. No application logic yet — structure, config, and CLAUDE.md files only.

**Git:** Before writing any files, create and check out branch `task/1-scaffold`. All work for this task happens on that branch. Open a PR to `main` when complete. Do not merge — Miles reviews and merges.

**Deliverables:**

- Full directory structure per Section 3
- Root `CLAUDE.md` — complete, per Section 5.2
- `services/graph-service/CLAUDE.md` — complete, per Section 5.3
- Root `README.md` — project overview, one-paragraph description, link to Fork Guide
- Root `.env.example` — all environment variables with descriptions, no values
- Root `.gitignore` — covers `.env.local`, `node_modules`, `dist`, `*.log`, `.DS_Store`
- `SECURITY.md` — standard responsible disclosure template
- `LICENSE` — MIT, copyright Miles Camp
- `docker-compose.yml` — starts local Neo4j + graph-service stub
- `.devcontainer/devcontainer.json` — per Section 13 (Dev Container)
- `pnpm-workspace.yaml` — declares `services/*` as workspace packages
- Root `package.json` — workspace root, scripts for running all services
- `tsconfig.base.json` — strict TypeScript base config
- `services/graph-service/package.json` — extends base tsconfig, Fastify + Neo4j driver dependencies
- `services/graph-service/tsconfig.json`
- `.eslintrc.js` + `.prettierrc` at root
- `.github/workflows/ci.yml` — all CI checks defined (stubs acceptable initially)

**Success criteria:** `pnpm install` completes. `docker-compose up` starts without errors. `pnpm --filter graph-service build` runs without TypeScript errors. CI pipeline triggers on the PR.

---

### 0.3 Agent Task 2 — Discogs API Exploration

**Goal:** Validate actual Discogs API responses against the schema assumptions in this spec before writing any production code. This is a discovery task.

**Git:** Create branch `task/2-discogs-exploration` from `main` (not from Task 1 branch). Use a worktree if running in parallel: `git worktree add ../liner-notes-task-2 task/2-discogs-exploration`.

**Deliverables:**

- `scripts/explore-discogs.ts` — standalone script that:
  1. Authenticates via `DISCOGS_TOKEN` from `.env.local`
  2. Fetches the first 5 releases from the collection
  3. Fetches full release details for one of them
  4. Pretty-prints the raw JSON to console
  5. Prints a field-by-field comparison against Section 6.4 of this spec
- `services/graph-service/tests/fixtures/sample-release.json` — one raw full release response
- `scripts/discogs-api-notes.md` — documents:
  - Any discrepancies between spec assumptions and actual API responses
  - Fields expected but missing
  - Fields present but not captured in the spec
  - Recommended schema adjustments

**Success criteria:** `pnpm tsx scripts/explore-discogs.ts` runs and produces output. `discogs-api-notes.md` exists with real findings.

**⚠️ Agent: pause after this task, report findings, and wait for confirmation before proceeding to Task 3.**

---

### 0.4 Agent Task 3 — graph-service Scaffold + Neo4j Connection

> Only begin after Task 2 findings are reviewed and schema is confirmed.

**Goal:** Working Fastify server with Neo4j connection, schema setup, and health endpoint.

**Git:** Branch `task/3-neo4j-connection` from `main`.

**Deliverables:**

- Full `src/` directory structure
- Fastify server setup at `src/server.ts`
- Neo4j driver at `src/db/client.ts`
- Schema setup script at `src/db/schema.ts` — applies all constraints and indexes idempotently
- `GET /api/v1/health` — returns `{ status: "ok", neo4j: "connected" }`
- `Dockerfile` that builds and runs the service
- All CI checks passing

**Success criteria:** `docker-compose up` → `curl http://localhost:3000/api/v1/health` returns `{ "status": "ok", "neo4j": "connected" }`.

---

## 1. Project Vision & Goals

### 1.1 What Is This?

**liner-notes** — a personal, open-source, forkable monorepo for exploring a vinyl record collection through a graph database. The name references the liner notes printed inside record sleeves: the credits, the studios, the session musicians, the producers. That information has always been there. This project digitizes that web of relationships and makes it queryable.

Your record collection is not a flat list — it is a deeply interconnected web of artists, musicians, studios, labels, eras, and sounds. A graph database is the natural way to model and explore that web.

Starting with a collection of ~200 records spanning the 1950s to present day, catalogued in Discogs ([macamp0328](https://www.discogs.com/user/macamp0328)), the goal is to pull that data into Neo4j and build an API enabling rich, relationship-driven exploration: "Who played bass on this record?", "What else was recorded in that studio?", "Which artists appear across the most records in my collection?", "What lyrical themes recur across a given decade?"

### 1.2 Goals

**Primary:**

- Hands-on experience with graph data structures, Neo4j, and Cypher
- Use graph modeling to answer questions that would be awkward or expensive in a relational database
- Deploy a running service on AWS with proper infrastructure as code
- Serve as solutions architect — designing the system and orchestrating AI agents to implement it

**Secondary:**

- Demonstrate full-stack product engineering competency (data modeling, API design, containerization, cloud infra)
- Portfolio artifact for product engineering role applications
- Build a system any music lover can fork and run with their own Discogs collection

**Non-goals (this sprint):**

- Frontend development (beyond Neo4j Bloom as POC explorer)
- Real-time sync
- Multi-user support
- Monetization

### 1.3 Design Principles

- **Graph-first:** If a concept can become a node with relationships rather than a flat property, make it a node.
- **Config-driven:** All user-specific data lives in environment variables. No hardcoded values.
- **Forkable by default:** Any music lover can clone, configure, and run this.
- **AI-native workflow:** CLAUDE.md files, CI gates, and clean interfaces are first-class requirements.
- **Free tier deployable:** Minimal to zero cost. Scale-to-zero is a priority given infrequent traffic.
- **Public-repo safe:** Repo starts private, goes public on first stable release. Treat as public from day one.

---

## 2. Learning Objectives

This project was directly motivated by _Designing Data-Intensive Applications_ by Martin Kleppmann (O'Reilly, 2017) — specifically Chapter 2, which compares relational, document, and graph data models. Having worked almost exclusively with relational databases professionally, this project is the hands-on companion: build something real with a graph to understand it from the inside.

Key concepts to build through this project:

- **Graph data modeling** — nodes and edges vs. tables and foreign keys
- **Cypher query language** — Neo4j's native graph query syntax
- **Traversal patterns** — depth-limited traversal, shortest path, pattern matching
- **Graph vs. relational tradeoffs** — when graphs win and when they don't
- **Neo4j operational basics** — indexing, constraints, schema design, query optimization

> 📚 _Designing Data-Intensive Applications_, Kleppmann — Chapter 2: Data Models and Query Languages. The property graph model sections are the direct inspiration for this architecture.

---

## 3. Monorepo Structure

```
liner-notes/
├── CLAUDE.md
├── README.md
├── SECURITY.md
├── LICENSE
├── .devcontainer/
│   └── devcontainer.json
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
├── scripts/
│   ├── explore-discogs.ts
│   └── discogs-api-notes.md
├── services/
│   └── graph-service/
│       ├── CLAUDE.md
│       ├── src/
│       │   ├── ingestion/
│       │   ├── api/
│       │   ├── db/
│       │   ├── enrichment/
│       │   └── index.ts
│       ├── tests/
│       │   ├── unit/
│       │   ├── integration/
│       │   └── fixtures/
│       ├── Dockerfile
│       ├── .env.example
│       └── README.md
├── infra/
│   ├── terraform/
│   │   ├── main.tf
│   │   ├── networking.tf
│   │   ├── ec2.tf
│   │   ├── ecr.tf
│   │   ├── iam.tf
│   │   └── variables.tf
│   └── k8s/
│       ├── namespace.yaml
│       └── graph-service/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### 3.1 Infrastructure for Future Services

- Shared infra (VPC, ECR, IAM, k8s cluster) → `/infra/` centrally managed
- Service K8s manifests → `/infra/k8s/{service-name}/`
- Service-specific AWS resources → `/infra/terraform/modules/{service-name}/`
- Each service owns its `Dockerfile`, `.env.example`, `CLAUDE.md`

---

## 4. Conventions & Tooling

**All locked. Agents must follow these exactly.**

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

**Why Fastify over Express:** Native TypeScript support, built-in JSON schema validation on request/response, `@fastify/swagger` + `@fastify/swagger-ui` for zero-friction OpenAPI docs (a hard requirement), and a cleaner plugin architecture. Significantly faster than Express under load.

### 4.2 Git Conventions

**Branching:**

| Branch type    | Naming pattern                 | Created by     |
| -------------- | ------------------------------ | -------------- |
| Agent tasks    | `task/{n}-{short-description}` | Agent          |
| Human features | `feat/{short-description}`     | Miles          |
| Fixes          | `fix/{short-description}`      | Agent or Miles |
| Docs/config    | `chore/{short-description}`    | Agent or Miles |

**Rules:**

- `main` is protected — no direct commits ever
- All changes via PR with CI passing
- Squash merge into `main` — one clean commit per task
- Commit message format is not enforced; use clear subjects (e.g. `feat:`, `fix:`, `chore:`) when helpful
- Branches are short-lived — agents complete a task, open a PR, done
- Never leave a branch open across multiple unrelated tasks

**Parallel agent work with worktrees:**

Multiple agents can work simultaneously on independent tasks. Each agent gets its own Git worktree so working directories never conflict:

```bash
# Agent A working on Task 2
git worktree add ../liner-notes-task-2 task/2-discogs-exploration

# Agent B working on Task 3 simultaneously
git worktree add ../liner-notes-task-3 task/3-neo4j-connection
```

Each worktree is a fully independent working directory pointing to its own branch. Agents operate entirely within their assigned worktree. **Agents manage all their own git operations** — branch creation, commits, and opening the PR. Miles only reviews and merges.

**Agent git workflow (every task):**

```bash
# 1. Start from latest main
git fetch origin
git checkout -b task/{n}-{description} origin/main

# 2. Work, committing incrementally with clear commit messages
git add .
git commit -m "feat: scaffold monorepo structure"

# 3. Push and open PR
git push -u origin task/{n}-{description}
gh pr create --title "task/{n}: {description}" --body "Closes #{issue}"
```

**Task design for parallelism:** Tasks in this spec are sequenced to avoid file overlap. When running agents in parallel, verify the tasks being parallelized don't touch the same files. If unsure, run sequentially.

### 4.3 Secrets Management

| File                | Committed?         | Purpose                                              |
| ------------------- | ------------------ | ---------------------------------------------------- |
| `.env.example`      | ✅ Yes             | Documents all variables with descriptions, no values |
| `.env.local`        | ❌ No (gitignored) | Local development values                             |
| AWS Secrets Manager | N/A (runtime)      | Production secrets injected at container startup     |

`.gitignore` must include: `.env`, `.env.local`, `.env.*.local`

Fastify loads `.env.local` via `dotenv-flow` or equivalent — configure explicitly, don't rely on framework magic.

**Never commit real values. Ever. CI runs a secrets scan on every PR.**

### 4.4 Code Style

- Prettier handles all formatting — formatter wins, no style debates
- ESLint handles code quality — all rules enforced in CI
- No `any` types unless justified with an inline comment
- All async functions use `async/await` — no raw Promise chains
- Explicit return types on all exported functions

---

## 5. Agentic AI Development Setup

### 5.1 Agent Guidance Philosophy

Specs in this document are **architectural guides**, not rigid requirements. Agents are expected to:

- Treat schema and API specs as the intended direction
- Research and self-discover (Discogs API docs, Neo4j best practices, Fastify ecosystem)
- Propose improvements, flag tradeoffs, explain deviations
- **Never silently do something different** — surface alternatives before implementing
- **Own all git operations** for their task — see Section 4.2

### 5.2 Root CLAUDE.md — Required Contents

The root `CLAUDE.md` must contain:

- Project name, vision, and one-paragraph summary
- Monorepo structure and what lives where
- **Full copy of Section 4** (conventions, runtime, Fastify, pnpm, git workflow, secrets)
- Git workflow detail: branch naming, worktree usage, agent-managed git, PR process
- How services communicate
- CI requirements — what must pass before a PR is mergeable
- Deployment overview
- How to add a new service
- Public repo safety rules — no secrets, no personal data hardcoded

### 5.3 graph-service CLAUDE.md — Required Contents

- Service purpose and scope
- Discogs API integration — endpoints, auth, rate limits (treat as guide; verify against live docs)
- Neo4j schema — nodes, relationships, constraints, indexes (treat as starting point; propose improvements)
- All API endpoints with request/response shapes
- Ingestion pipeline steps
- OpenAPI/Swagger requirement via `@fastify/swagger`
- Testing requirements, how to run locally
- Docker build and local run
- Known limitations: studio data sparsity, Musician/Artist deduplication via `SAME_PERSON_AS`

### 5.4 CI Gates (GitHub Actions)

| Check             | Tool                      | Requirement                                      |
| ----------------- | ------------------------- | ------------------------------------------------ |
| Linting           | ESLint                    | Zero warnings or errors                          |
| Type checking     | TypeScript strict         | Zero errors                                      |
| Unit tests        | Vitest                    | 70% coverage minimum                             |
| Integration tests | Supertest/inject          | 100% of API routes covered                       |
| Docker build      | Docker                    | Image builds successfully                        |
| Schema validation | Custom script             | Constraints + indexes apply cleanly to seed data |
| Security scan     | `pnpm audit` + Dependabot | No critical vulnerabilities                      |
| Secrets scan      | `trufflehog`              | No credentials or tokens in committed code       |

---

## 6. Discogs API Integration

### 6.1 Overview

- **Base URL:** `https://api.discogs.com`
- **Version:** v2.0 (RESTful, JSON)
- **Auth:** Personal access token (read-only)
- **Rate limits:** 60 req/min authenticated; ~25 unauthenticated
- **Pagination:** All list endpoints include a `pagination` object

> ⚠️ **Agent note:** Verify current rate limits and endpoint behavior against [live Discogs API docs](https://www.discogs.com/developers) before implementation.

### 6.2 Configuration

```env
DISCOGS_USERNAME=your_discogs_username
DISCOGS_TOKEN=your_personal_access_token
DISCOGS_USER_AGENT=liner-notes/1.0 +https://github.com/macamp0328/liner-notes
DISCOGS_REQUEST_DELAY_MS=1000
```

### 6.3 Key Endpoints

| Endpoint                                              | Purpose                                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| `GET /users/{username}/collection/folders/0/releases` | All collection releases (paginated; folder 0 = all) |
| `GET /releases/{release_id}`                          | Full release — artists, labels, credits, tracklist  |
| `GET /artists/{artist_id}`                            | Artist — name, profile, aliases, members            |
| `GET /labels/{label_id}`                              | Label — name, parent, country                       |
| `GET /masters/{master_id}`                            | Master — canonical version grouping                 |

### 6.4 Data Per Release

```
title, year, country, genres[], styles[], formats[]
artists[]       → name, id, role
extraartists[]  → name, id, role  (producers, engineers, session musicians)
labels[]        → name, id, catno
tracklist[]     → position, title, duration, extraartists[]
companies[]     → name, id, entity_type_name  ("Recorded At" = studio)
images[]        → uri, type
master_id
```

> ⚠️ **Known gap:** Studio data in `companies[]` is inconsistently populated. Studio nodes will be sparse. Accept this; document it in the README.

### 6.5 Rate Limiting

- Configurable delay: `DISCOGS_REQUEST_DELAY_MS` (default 1000ms)
- Exponential backoff on `429`
- Log all rate limit hits
- ~10–15 min ingestion for 200 records

### 6.6 Auth

Personal token for this sprint. Discogs OAuth in a future sprint.

> 📌 GitHub Issue to create: `feat: Discogs OAuth for fork-friendly auth`

---

## 7. Neo4j Graph Schema

### 7.1 Philosophy

Guiding question for every data field: _Should this be a node with relationships, or a property?_ If other nodes might share it, or if you'd want to traverse to/from it — make it a node. Goal: thousands of nodes, tens of thousands of edges from a 200-record collection.

> ⚠️ **Agent note:** Research Neo4j modeling best practices and validate against actual API responses (Agent Task 2 findings) before implementing. Propose improvements explicitly.

### 7.2 Nodes

| Label      | Key Properties                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `Release`  | `discogsId` (unique), `title`, `year` (integer — also related to Decade), `format`, `thumbUrl`, `masterDiscogsId` |
| `Artist`   | `discogsId` (unique), `name`, `realName`, `profile`                                                               |
| `Label`    | `discogsId` (unique), `name`, `profile`, `contactInfo`                                                            |
| `Track`    | `position`, `title`, `duration`, `lyrics` (nullable), `lyricsSource`                                              |
| `Genre`    | `name` (unique)                                                                                                   |
| `Style`    | `name` (unique)                                                                                                   |
| `Country`  | `name` (unique)                                                                                                   |
| `Decade`   | `name` (unique) — e.g., `"1970s"`                                                                                 |
| `Studio`   | `name`, `location`                                                                                                |
| `Musician` | `discogsId` (if available), `name`                                                                                |
| `Producer` | `discogsId` (if available), `name`                                                                                |
| `Engineer` | `discogsId` (if available), `name`                                                                                |

> `year` is stored both as a property on `Release` (for exact-year queries) and as a `RECORDED_IN_DECADE` relationship to a `Decade` node (for decade traversal). Both are needed.

> Separate labels for Musician/Producer/Engineer are intentional — more expressive, even though less normalized.

### 7.3 Relationships

| Relationship         | From → To          | Properties             |
| -------------------- | ------------------ | ---------------------- |
| `RELEASED_BY`        | Release → Artist   | `role`                 |
| `CREDITED_ON`        | Musician → Release | `role`, `instrument`   |
| `PRODUCED_BY`        | Release → Producer |                        |
| `ENGINEERED_BY`      | Release → Engineer |                        |
| `ON_LABEL`           | Release → Label    | `catalogNumber`        |
| `IN_GENRE`           | Release → Genre    |                        |
| `IN_STYLE`           | Release → Style    |                        |
| `FROM_COUNTRY`       | Release → Country  |                        |
| `RECORDED_IN_DECADE` | Release → Decade   |                        |
| `RECORDED_AT`        | Release → Studio   |                        |
| `HAS_TRACK`          | Release → Track    | `trackNumber`          |
| `PERFORMED_BY`       | Track → Artist     | `role`                 |
| `SAME_PERSON_AS`     | Musician → Artist  |                        |
| `MEMBER_OF`          | Artist → Artist    | `startYear`, `endYear` |
| `SUBSIDIARY_OF`      | Label → Label      |                        |
| `VERSION_OF`         | Release → Release  |                        |

### 7.4 Constraints & Indexes

```cypher
CREATE CONSTRAINT ON (r:Release) ASSERT r.discogsId IS UNIQUE;
CREATE CONSTRAINT ON (a:Artist) ASSERT a.discogsId IS UNIQUE;
CREATE CONSTRAINT ON (l:Label) ASSERT l.discogsId IS UNIQUE;
CREATE CONSTRAINT ON (g:Genre) ASSERT g.name IS UNIQUE;
CREATE CONSTRAINT ON (s:Style) ASSERT s.name IS UNIQUE;
CREATE CONSTRAINT ON (c:Country) ASSERT c.name IS UNIQUE;
CREATE CONSTRAINT ON (d:Decade) ASSERT d.name IS UNIQUE;

CALL db.index.fulltext.createNodeIndex("trackLyrics", ["Track"], ["lyrics", "title"]);

CREATE INDEX ON :Release(year);
CREATE INDEX ON :Musician(name);
CREATE INDEX ON :Studio(name);
```

### 7.5 Example Queries

```cypher
// Releases featuring a specific bassist
MATCH (m:Musician)-[:CREDITED_ON {instrument: "Bass"}]->(r:Release)
WHERE m.name CONTAINS "Jamerson"
RETURN r.title, r.year ORDER BY r.year

// Decade + label intersection
MATCH (r:Release)-[:RECORDED_IN_DECADE]->(:Decade {name: "1960s"}),
      (r)-[:ON_LABEL]->(:Label {name: "Blue Note Records"})
RETURN r.title, r.year

// Two-hop shared musician discovery
MATCH (r1:Release {title: "Head Hunters"})<-[:CREDITED_ON]-(m:Musician)-[:CREDITED_ON]->(r2:Release)
WHERE r1 <> r2
RETURN r2.title, m.name, m.instrument

// Exact year
MATCH (r:Release) WHERE r.year = 1972 RETURN r.title ORDER BY r.title

// Lyrics full-text
CALL db.index.fulltext.queryNodes("trackLyrics", "freedom soul river")
YIELD node, score RETURN node.title, score ORDER BY score DESC
```

---

## 8. Data Ingestion Pipeline

### 8.1 Steps

```
1. Validate config (env vars, Neo4j connectivity, Discogs auth)
2. Apply schema (idempotent)
3. Fetch collection paginated via GET /users/{username}/collection/folders/0/releases
4. For each release:
   a. GET /releases/{release_id}
   b. Extract all entities
   c. Derive Decade from year
   d. MERGE all nodes and relationships
   e. Sleep DISCOGS_REQUEST_DELAY_MS
5. Lyrics enrichment:
   a. For each Track without lyrics → query LRCLIB
   b. Update Track node with lyrics + lyricsSource
6. Log summary: nodes, relationships, lyrics enriched, errors, duration
```

### 8.2 Idempotency

All writes use Cypher `MERGE`. Re-running is safe. New additions picked up on re-run.

### 8.3 Triggers

- **Auto:** On startup if no `Release` nodes exist
- **Manual:** `POST /api/v1/admin/ingest` (requires `ADMIN_TOKEN`)

### 8.4 Lyrics

- Primary: LRCLIB (free, no API key)
- Fallback: Genius API (free tier, key required)
- Missing lyrics are acceptable — best-effort

---

## 9. API Layer

### 9.1 Technology

**Fastify** with `@fastify/swagger` + `@fastify/swagger-ui` for auto-generated OpenAPI docs at `/api/docs`. Keep Cypher query logic in a repository layer (not directly in route handlers) — this keeps GraphQL as an addable future layer without a rewrite.

### 9.2 Endpoints

#### Collection

| Method | Path                          | Description                       |
| ------ | ----------------------------- | --------------------------------- |
| `GET`  | `/api/v1/releases`            | List releases, paginated          |
| `GET`  | `/api/v1/releases/:discogsId` | Single release with relationships |
| `GET`  | `/api/v1/artists/:discogsId`  | Artist with connected releases    |
| `GET`  | `/api/v1/labels/:discogsId`   | Label with all releases           |

#### Exploration

| Method | Path                                     | Description                             |
| ------ | ---------------------------------------- | --------------------------------------- |
| `GET`  | `/api/v1/explore/musician/:name`         | Releases featuring this musician        |
| `GET`  | `/api/v1/explore/studio/:name`           | Releases at this studio                 |
| `GET`  | `/api/v1/explore/decade/:decade`         | Releases from this decade               |
| `GET`  | `/api/v1/explore/year/:year`             | Releases from this exact year           |
| `GET`  | `/api/v1/explore/label/:name`            | Releases on this label                  |
| `GET`  | `/api/v1/explore/genre/:name`            | Releases in this genre                  |
| `GET`  | `/api/v1/explore/style/:name`            | Releases in this style                  |
| `GET`  | `/api/v1/explore/country/:name`          | Releases from this country              |
| `GET`  | `/api/v1/explore/connections/:discogsId` | Graph traversal (`?depth=2`)            |
| `GET`  | `/api/v1/explore/shared-musicians`       | Release pairs sharing session musicians |

#### Search

| Method | Path                       | Description                              |
| ------ | -------------------------- | ---------------------------------------- |
| `GET`  | `/api/v1/search?q=`        | Full-text across titles, artists, tracks |
| `GET`  | `/api/v1/search/lyrics?q=` | Full-text within lyrics                  |

#### Admin & Ops

| Method | Path                          | Description                                |
| ------ | ----------------------------- | ------------------------------------------ |
| `POST` | `/api/v1/admin/ingest`        | Trigger ingestion (requires `ADMIN_TOKEN`) |
| `GET`  | `/api/v1/admin/ingest/status` | Last ingestion stats                       |
| `GET`  | `/api/v1/health`              | Service + Neo4j status                     |
| `GET`  | `/api/docs`                   | Swagger UI                                 |

### 9.3 Response Shapes

```json
// List
{ "data": [...], "pagination": { "page": 1, "limit": 20, "total": 200 } }

// Single
{ "data": { ... } }

// Error
{ "error": { "code": "NOT_FOUND", "message": "Release not found" } }
```

### 9.4 Security

No hard rate limiting on the service itself. `@fastify/rate-limit` as a basic stopgap; Cloudflare now fronts the service (#119), so edge-level bot mitigation / rate limiting can be handled there.

---

## 10. Infrastructure & Deployment

### 10.1 Local Development

```bash
cp .env.example .env.local   # fill in values
docker-compose up
# API:   http://localhost:3000/api/v1
# Docs:  http://localhost:3000/api/docs
```

### 10.2 Architecture

```
Internet
    │
[Cloudflare — TLS + custom domain]  ← live (#119); origin locked to Cloudflare IPs
    │
[EC2 t3.micro — k3s single-node Kubernetes]
    └── graph-service Pod

[Neo4j Aura Free]       — external managed database
[AWS ECR]               — container registry
[AWS Secrets Manager]   — runtime secrets
[AWS CloudWatch]        — logs + alerts
```

### 10.3 Decisions

| Component  | Choice              | Rationale                                                                       |
| ---------- | ------------------- | ------------------------------------------------------------------------------- |
| Kubernetes | k3s on EC2 t3.micro | EKS = ~$72/month (off the table). k3s is fully conformant K8s on free-tier EC2. |
| Neo4j      | Aura Free           | Managed, 200MB free, zero ops burden.                                           |
| Registry   | AWS ECR             | 500MB free tier, native AWS integration.                                        |
| Logs       | CloudWatch          | Free tier sufficient.                                                           |
| Secrets    | AWS Secrets Manager | Cleanest for a public repo (~$0.40/secret/month).                               |

> **k3s:** Lightweight certified Kubernetes, runs as a single binary on EC2 t3.micro. Supports all standard K8s manifests. Control plane runs on the same instance. Functionally equivalent to EKS for this project's scale.

### 10.4 Scale-to-Zero

Infrequent traffic — EC2 Scheduler to stop the instance on a schedule and restart on demand is the first-pass solution (~$0/month when stopped). Revisit ECS Fargate (true scale-to-zero, ~30s cold start) if the always-on cost matters more than the K8s learning goal.

### 10.5 CI/CD

- **On PR:** Full CI suite
- **On merge to `main`:** Build → push to ECR → rolling k8s update
- **Terraform:** Manual approval gate before `apply`

---

## 11. Testing

### 11.1 Unit Tests

- Discogs response parsing and transformation
- Neo4j node/relationship builders
- Decade derivation from year
- Rate limiting and retry logic

### 11.2 Integration Tests

- All API endpoints via Fastify's `inject()` against a test Neo4j instance
- Ingestion pipeline against mocked Discogs fixtures
- Full-text search on seed data
- Auto-ingest on empty graph

### 11.3 Seed Data

First 10 releases from the collection. Stored as JSON fixtures in `tests/fixtures/`. Review after first ingestion for graph richness (want: shared musicians, overlapping studios/labels).

---

## 12. Observability

**Minimum viable this sprint:**

- Structured JSON logging (request ID, timestamps, error context, ingestion stats)
- `/api/v1/health` returns Neo4j + service status
- Ingestion summary logged on completion
- CloudWatch log shipping + service-down alarm

**Future (add when justified):**

- Neo4j slow query log
- API response time histograms
- Discogs rate limit headroom
- Grafana if a concrete need emerges

> Principle: every tool added should be explainable. Don't add observability because it looks good.

---

## 13. Future Sprints

### Dev Container ← Implement in Agent Task 1

`.devcontainer/devcontainer.json` so the full dev environment loads in VS Code or GitHub Codespaces with zero manual setup.

**Pre-installed tools:** Node.js v22.x, pnpm, Docker-in-Docker, AWS CLI, kubectl, Terraform, Neo4j Cypher shell, GitHub CLI

**VS Code extensions:** ESLint, Prettier, TypeScript, Neo4j (official), Docker, GitLens, REST Client, Terraform (HashiCorp)

**Port forwarding:** 3000 (API), 7474 (Neo4j Browser), 7687 (Neo4j Bolt)

---

### POC: Visual Graph Explorer

Use **Neo4j Bloom** (included free with Aura) as the first exploration layer — point-and-click graph traversal, no code. Validates the backend is ingesting correctly. Document as the default exploration tool in the README until a custom frontend exists.

---

### MCP Service — Natural Language Collection Explorer

A service that exposes the graph as MCP tools, letting an LLM (Claude) answer natural language questions about the collection: "What's the most connected artist in my collection?", "Find me something from a Motown session musician who also played on a rock record."

**Service:** `services/collection-mcp/`

**Tools to expose:** `search_releases`, `get_release_connections`, `find_releases_by_musician`, `explore_artist`, `search_lyrics`, `get_collection_stats`

**Architecture:** MCP server talks to `graph-service` REST API — not directly to Neo4j. Graph-service remains the single data access layer.

---

### Frontend: Album Cover Browser

Visual, tactile interface — digital crate digging. From a cover, jump into graph exploration. Framework and hosting TBD.

### Frontend: Gamified App

Game-like exploration on the same backend — trivia, "six degrees," blind identification. Concept TBD.

### Analytics Layer

Entropy/diversity scores, decade distribution, label spread. HHI and Shannon entropy as collection diversity metrics.

### Periodic Discogs Sync

Incremental ingestion of new collection additions without full re-run.

### Cloudflare Edge Layer

TLS + custom domain via Cloudflare already landed (#119) — the API is served over HTTPS with the origin locked to Cloudflare's IPs. Remaining edge scope (add when there's a concrete need): edge caching, CDN for album art, and bot protection rules.

### Discogs OAuth

> 📌 GitHub Issue: `feat: Discogs OAuth for fork-friendly auth`

---

## 14. Open Questions

| #   | Question                                     | Priority | Decision                                                |
| --- | -------------------------------------------- | -------- | ------------------------------------------------------- |
| 2   | k3s on EC2 vs ECS Fargate for scale-to-zero? | 🟡       | k3s current recommendation; dedicated discussion needed |
| —   | All other questions                          | ✅       | Resolved — see Section 4 and throughout                 |

---

## 15. Public Repo Checklist

Before making the repo public:

- [ ] Run `trufflehog` against full git history — no secrets anywhere
- [ ] All `.env*` files (except `.env.example`) in `.gitignore`
- [ ] `SECURITY.md` present
- [ ] `LICENSE` (MIT) present
- [ ] Secrets scan CI check green
- [ ] README explains fork setup without referencing `macamp0328`
- [ ] `macamp0328` and personal details removed from committed config
- [ ] `docker-compose.yml` uses only public images or local Dockerfile builds

---

## 16. Fork Guide

```bash
# 1. Clone
git clone https://github.com/yourusername/liner-notes.git
cd liner-notes

# 2. Open in VS Code → "Reopen in Container" (or use GitHub Codespaces)
# Zero-setup environment via .devcontainer

# 3. Configure
cp .env.example .env.local
# Set: DISCOGS_USERNAME, DISCOGS_TOKEN, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, ADMIN_TOKEN

# 4. Get credentials
# Discogs token: https://www.discogs.com/settings/developers
# Neo4j Aura Free: https://console.neo4j.io

# 5. Start
docker-compose up

# 6. Ingest (auto on empty graph, or manually)
curl -X POST http://localhost:3000/api/v1/admin/ingest \
  -H "Authorization: Bearer your_admin_token"

# 7. Explore
# Neo4j Bloom: https://console.neo4j.io
# API: http://localhost:3000/api/v1/releases
# Docs: http://localhost:3000/api/docs
```

---

_Draft v0.5 — May 2026_  
_All decisions locked. Prerequisites complete. Ready for Agent Task 1._
