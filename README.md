# liner-notes

A personal, open-source, forkable monorepo for exploring a vinyl record collection through a graph database. Your record collection is not a flat list — it is a deeply interconnected web of artists, musicians, studios, labels, eras, and sounds. **liner-notes** pulls a [Discogs](https://www.discogs.com) collection into [Neo4j](https://neo4j.com) and exposes a REST API for rich, relationship-driven exploration: "Who played bass on this record?", "What else was recorded at that studio?", "Which artists appear across the most records in my collection?"

## Motivation

This project is the hands-on companion to Chapter 2 of [_Designing Data-Intensive Applications_](https://dataintensive.net) (Martin Kleppmann, O'Reilly 2017), which compares the relational, document, and graph data models. After years working almost exclusively with relational databases, the goal here is to learn the property-graph model from the inside by building something real with it — graph data modeling, Cypher, traversal patterns (shortest path, depth-limited matching), and the operational basics of indexing, constraints, and query optimization in Neo4j. A record collection is a natural fit: the credits in the liner notes are already a graph, so the questions worth asking ("which session musician connects these two records?") are exactly the ones graphs answer well and relational schemas answer awkwardly.

## Services

| Service       | Path                      | Description                                 |
| ------------- | ------------------------- | ------------------------------------------- |
| graph-service | `services/graph-service/` | Fastify REST API + Neo4j ingestion pipeline |

## What's changed lately?

The repo keeps a plain-English, **AI-written, versioned changelog**. Every successful production
deploy auto-cuts a **published, tagged CalVer release** (`vYYYY.MM.DD`) describing what went live,
with note richness that ramps with the release's importance; a rolling **`unreleased` draft** shows
what's merged but not yet shipped. Read it in the **[Releases](../../releases)** tab — the latest
version is the repo's "Latest release."

It's generated automatically: every merge summarises the PR with Claude (up to two sentences) —
falling back to the PR title when no `ANTHROPIC_API_KEY` is configured (e.g. on a fork) — into a
structured store; a deploy cuts the version; a weekly job self-heals anything missed. No manual
upkeep, no committed `CHANGELOG.md`. See
[`scripts/changelog/README.md`](scripts/changelog/README.md) for how it works and how to fork it.

## Data model

Your collection's graph — every node label, its properties, and how they connect — is generated
**straight from the live production database**, not a hand-maintained doc that quietly goes stale.
Browse it as an interactive, pan-and-zoom diagram:

**[→ Live schema diagram](https://macamp0328.github.io/liner-notes/)**

A scheduled job re-introspects prod and opens a PR with any model changes (plus a drift report against
`src/db/schema.ts`), so the picture stays current with zero hand-maintenance. See [ADR 0004](docs/adr/0004-data-model-diagrams-from-live-introspection.md)
for the design and [`scripts/schema-diagram/README.md`](scripts/schema-diagram/README.md) for the tool. The same
entity-relationship and graph-of-labels views also render in
[`services/graph-service/docs/schema/SCHEMA.md`](services/graph-service/docs/schema/SCHEMA.md), backed by
a machine-readable snapshot.

## Backups (yes, the record-collection app has disaster recovery)

The production graph is **backed up weekly to S3 — and the restore path is drill-tested against
real production data**, not assumed to work. Every Sunday an in-cluster job streams the entire
graph out of Neo4j Aura over Bolt (Aura Free forbids APOC file export, so it's plain Cypher all
the way down) as gzipped JSONL through a lossless type-tagged codec: integers past 2^53,
nanosecond-precision zoned datetimes, multi-label nodes, the lot. The whole production graph —
**8,000+ nodes and 28,000 relationships — is a 1.9 MB object** that restores anywhere in under a
minute, and every backup carries its own manifest: the restore tool exits non-zero unless the
result **provably matches the export**, byte-for-byte on encoded properties.

Why bother, for a hobby graph? Because it's no longer fully rebuildable — some enrichment (the
Genius-sourced lyrics) can only be harvested from a residential IP and was permanently lost once
before — and a rebuild from upstream APIs takes hours against sources that drift. The backup is
also deliberately **uptime-aligned** with the scale-to-zero design: it only runs while the node is
up, so "everything off" still costs ~$0, and the S3 objects are what survive Aura Free's
90-day paused-instance deletion. Procedure and drill log:
[`infra/RUNBOOK.md` → Graph backup and restore](infra/RUNBOOK.md#graph-backup-and-restore).

## Quick Start

```bash
# 1. Clone (replace yourusername with your fork, or macamp0328 for the origin)
git clone https://github.com/yourusername/liner-notes.git
cd liner-notes

# 2. Configure
cp .env.example .env.local
# Edit .env.local — set DISCOGS_USERNAME, DISCOGS_TOKEN, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, ADMIN_TOKEN

# 3. Install tools and dependencies
mise install  # installs Node, pnpm, and all other pinned tools
pnpm install  # installs JS dependencies

# 4. Start services
docker-compose up

# 5. API and docs
open http://localhost:3000/api/v1/health
open http://localhost:3000/api/docs
```

## Testing the API with Insomnia

A ready-to-import [Insomnia](https://insomnia.rest) collection is committed at
[`services/graph-service/docs/insomnia.collection.yaml`](services/graph-service/docs/insomnia.collection.yaml)
— every endpoint pre-built, foldered by tag (admin sub-foldered per enrichment stage), with
**Local** (`http://localhost:3000`) and **Production** sub-environments sharing a `base_url`
variable. Requires Insomnia ≥ 11.0.2 (earlier 11.0.x had a broken v5 folder importer).

1. Insomnia → `Import` → select the YAML file.
2. Pick the environment (Local/Production) from the environment switcher.
3. For admin routes, open the **Base Environment** and paste your `ADMIN_TOKEN` into the empty
   `admin_token` value. The admin folder carries bearer auth that every admin request inherits.
   Never commit a real token — the committed file always ships it empty.

Notes:

- The destructive `POST /api/v1/admin/reset` request ships with its `confirm=wipe-all` query param
  **disabled** — tick the checkbox to arm it deliberately.
- Re-importing **duplicates** the collection (Insomnia regenerates ids on import). To pick up
  changes: delete the old collection, import fresh, re-paste `admin_token`.
- The file is generated from the OpenAPI spec — never edit it by hand. `pnpm insomnia:generate`
  rebuilds `openapi.json` + the collection from the live route definitions;
  [CI fails on drift](.github/workflows/insomnia.yml). Forks with their own production domain:
  set `PROD_API_URL` when regenerating **and** add the same value as a GitHub repo variable
  named `PROD_API_URL` so the drift check regenerates with it.

## Requirements

- [mise](https://mise.jdx.dev) — manages Node.js, pnpm, terraform, kubectl, helm, gh, and aws-cli at the versions pinned in `.mise.toml`. Install once with `brew install mise`, then `mise install` from the repo root.
- Docker Desktop — for local Neo4j via `docker-compose up`
- A [Discogs personal access token](https://www.discogs.com/settings/developers)
- Neo4j — `docker-compose up` starts a local instance automatically. A [Neo4j Aura Free](https://console.neo4j.io) instance is only needed for production deployment.

## Fork & Run Your Own Collection

See [Quick Start](#quick-start) above for step-by-step instructions to run this with your own Discogs collection — clone, fill in `.env.local` (Discogs token + Neo4j connection), `mise install && pnpm install`, then `docker-compose up`. The collection auto-ingests on an empty graph, or trigger it manually with `POST /api/v1/admin/ingest` (requires `ADMIN_TOKEN`).

## Architecture

The production deployment is a single-node k3s cluster on EC2, with [Neo4j AuraDB Free](https://console.neo4j.io) as the managed graph database and a small set of AWS services (ECR, Secrets Manager, CloudWatch) providing operational glue. [Cloudflare](https://www.cloudflare.com) sits in front of the service — it terminates TLS for a custom domain (the reference instance is served at `ln-api.impressivelyadequate.com`) and forwards to the origin, which only accepts traffic from Cloudflare's IP ranges. This front door is opt-in (`cloudflare_enabled`); a fork runs over plain HTTP on the NodePort until it's configured.

<!-- diagrams:request-flow:start -->

```mermaid
flowchart LR
  user([Your laptop / browser]):::ext
  cloudflare["Cloudflare<br/>DNS · TLS · origin rule :30080"]:::ext

  subgraph aws["AWS account · region us-east-1"]
    direction TB

    subgraph vpc["VPC 10.0.0.0/16 · public subnet · SG opens :30080"]
      direction TB

      subgraph ec2["EC2 t3.small · AL2023 · k3s single-node"]
        direction TB

        subgraph ns["k8s namespace: liner-notes"]
          direction TB
          svc[/"Service · NodePort 30080"/]
          pod["Pod · graph-service"]
          k8s_secret[("Secret · graph-service-secrets")]
          k8s_pull[("Secret · ecr-pull-secret<br/>(dockerconfigjson)")]
          cron["CronJob · ecr-pull-secret-refresher<br/>every 6h"]
          cron_backup["CronJob · graph-backup<br/>weekly (Sun 10:00 ET)"]
          svc --> pod
          k8s_secret -.envFrom.-> pod
          k8s_pull -.imagePullSecret.-> pod
          cron -- "writes refreshed token" --> k8s_pull
          k8s_secret -.envFrom.-> cron_backup
          k8s_pull -.imagePullSecret.-> cron_backup
        end

        subgraph eso["k8s namespace: external-secrets"]
          eso_op["External Secrets Operator"]
        end

        eso_op -- "syncs every 1h" --> k8s_secret
      end
    end

    subgraph account["AWS account scope (outside the VPC)"]
      direction TB
      ecr["ECR · liner-notes/graph-service<br/>(last 10 tagged images)"]
      sm["Secrets Manager<br/>liner-notes/graph-service/prod"]
      s3[("S3 · graph backups<br/>(gzipped JSONL · 60-day lifecycle)")]
      iam["EC2 IAM role · ec2_k3s<br/>ECR read · SM read · SSM · S3 backup write"]
    end
    iam -.attached.-> ec2
  end

  subgraph external["External services"]
    direction TB
    aura[("Neo4j AuraDB Free · GCP<br/>neo4j+s:// · :7687")]:::ext
    discogs[("Discogs API<br/>https · 60 req/min")]:::ext
  end

  user -- "https" --> cloudflare
  cloudflare -- "http :30080 (origin rule)" --> svc
  pod == "Cypher · neo4j+s://" ==> aura
  pod -.ingest.-> discogs
  cron == "ecr get-login-password<br/>(IMDS → instance role)" ==> ecr
  eso_op == "GetSecretValue<br/>(IMDS → instance role)" ==> sm
  pod == "image pull<br/>(via dockerconfigjson)" ==> ecr
  cron_backup == "full-graph Cypher read" ==> aura
  cron_backup == "PutObject<br/>(IMDS → instance role)" ==> s3

  subgraph legend["Edge legend &nbsp;·&nbsp; color = flow category"]
    direction LR
    lr1[src]:::legendNode -- "user request" --> lr2[sink]:::legendNode
    ld1[src]:::legendNode == "heavy data path" ==> ld2[sink]:::legendNode
    lc1[src]:::legendNode -. "secret sync / control plane" .-> lc2[sink]:::legendNode
    le1[src]:::legendNode -. "external egress" .-> le2[sink]:::legendNode
  end

  %% Edge indices follow declaration order across the entire file.
  %% Main edges (0–16):
  %%   0  svc --> pod                          (request)
  %%   1  k8s_secret -.envFrom.-> pod          (mount, gray default)
  %%   2  k8s_pull -.imagePullSecret.-> pod    (mount, gray default)
  %%   3  cron -- "writes refreshed token" --> k8s_pull   (secret sync)
  %%   4  k8s_secret -.envFrom.-> cron_backup  (mount, gray default)
  %%   5  k8s_pull -.imagePullSecret.-> cron_backup       (mount, gray default)
  %%   6  eso_op -- "syncs every 1h" --> k8s_secret       (secret sync)
  %%   7  iam -.attached.-> ec2                (attachment, gray default)
  %%   8  user --> cloudflare                  (request)
  %%   9  cloudflare --> svc                   (request)
  %%  10  pod ==> aura                         (data path)
  %%  11  pod -.ingest.-> discogs              (external egress)
  %%  12  cron ==> ecr                         (secret sync — image-pull token)
  %%  13  eso_op ==> sm                        (secret sync)
  %%  14  pod ==> ecr                          (data path — image pull)
  %%  15  cron_backup ==> aura                 (data path — full-graph export read)
  %%  16  cron_backup ==> s3                   (data path — backup upload)
  %% Legend edges (17–20):
  %%  17  lr1 --> lr2                          (request)
  %%  18  ld1 ==> ld2                          (data path)
  %%  19  lc1 -.-> lc2                         (secret sync)
  %%  20  le1 -.-> le2                         (external egress)
  linkStyle 0,8,9,17 stroke:#0f172a,stroke-width:2px
  linkStyle 10,14,15,16,18 stroke:#1d4ed8,stroke-width:2.5px
  linkStyle 3,6,12,13,19 stroke:#7c3aed,stroke-width:1.8px
  linkStyle 11,20 stroke:#15803d,stroke-width:1.8px

  classDef ext fill:#f4f4f4,stroke:#999,stroke-dasharray:5 3
  classDef legendNode fill:#ffffff,stroke:#cbd5e1,color:#475569
```

<!-- diagrams:request-flow:end -->

The diagram above is the **logical request flow** — what talks to what at runtime.

Below is the **Terraform resource graph**, auto-generated from every `.tf` file under `infra/terraform/`. Inframap parses the dependency tree the cloud provisioner walks; the generator then post-processes that into AWS-region-framed category clusters (Networking, Compute, IAM, Secrets, Storage & Registry, Observability) with per-resource icons and short type captions:

![Resource graph](infra/diagrams/resource-graph.svg)

For per-file Mermaid diagrams showing what each `.tf` file declares and which other files it references, see [`infra/diagrams/per-file/`](infra/diagrams/per-file/) — one diagram per file, useful for understanding a single resource group in isolation.

All diagrams under `infra/diagrams/` are regenerated by `pnpm diagrams:generate` (locally) or by the [`diagrams.yml` workflow](.github/workflows/diagrams.yml) on any PR that touches `infra/terraform/**`. The hand-maintained logical flow lives in [`infra/diagrams/request-flow.mmd`](infra/diagrams/request-flow.mmd) — edit it there and re-run the generator to update both this README and the [operator runbook](infra/RUNBOOK.md).

Local install for the generator: `brew install inframap` on macOS, plus a running Docker daemon (already required for `docker-compose up`). Graphviz itself runs in a pinned Docker image (`nshine/dot:2.40.1`) so the rendered SVG is byte-identical across Mac, Linux, and CI — no more "regenerated locally vs in CI" drift. CI mirrors this: `go install github.com/cycloidio/inframap@v0.8.1` plus `docker pull` of the same pinned image — see [`diagrams.yml`](.github/workflows/diagrams.yml).

## Stack

- **Runtime:** Node.js v22.x + TypeScript (strict)
- **Framework:** Fastify v5
- **Database:** Neo4j (Aura Free)
- **Package manager:** pnpm workspaces
- **Module system:** ESM — `"type": "module"` on all services, `module: NodeNext` in tsconfig. All local/relative imports use `.js` extensions (enforced by the TypeScript compiler). This keeps the module format, the TypeScript config, and the runtime all aligned.
- **Testing:** Vitest
- **Infrastructure:** k3s on EC2 t3.small, AWS ECR, AWS Secrets Manager

## License

MIT — see [LICENSE](LICENSE).
