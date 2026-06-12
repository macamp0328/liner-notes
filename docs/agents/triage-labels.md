# Issue labels & triage queue

This is the **single source of truth** for the issue-tracker label vocabulary. Skills (`triage`,
`to-issues`, `issue`) and any agent creating or sorting issues read from here. The rationale and the
features we deliberately skipped live in [ADR 0002](../adr/0002-issue-organization.md).

Every issue carries **exactly one label from each of the four axes** (status, area, type, priority),
plus the optional `blocked` modifier. Claude Code applies all four when it opens an issue — see
"Auto-apply rule" below.

## Axis 1 — Status (the pickup axis)

The five canonical triage roles (these are also the strings the matt-pocock `triage` skill speaks in
— mapped 1:1, no fork):

| Label             | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `needs-triage`    | Not yet evaluated; needs a maintainer decision                |
| `needs-info`      | Waiting on an external answer before it can proceed           |
| `ready-for-agent` | Fully specified — an AFK agent can pick it up cold            |
| `ready-for-human` | Needs human judgment, design, or external access to implement |
| `wontfix`         | Will not be actioned (apply, then close)                      |

`blocked` is a **modifier**, not a sixth state: it co-exists with `ready-for-agent` /
`ready-for-human` and means "depends on another open issue, not actionable yet". The ready-queue
filters it out with `-label:blocked`.

## Axis 2 — Area (one per monorepo component)

| Label             | Scope                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `area:ingestion`  | Discogs ingestion pipeline (`src/ingestion/`)                       |
| `area:enrichment` | Lyrics, MusicBrainz, nationality, audio, genres (`src/enrichment/`) |
| `area:graph`      | Neo4j schema, repositories, Cypher, graph modeling (`src/db/`)      |
| `area:api`        | Fastify routes, REST surface, OpenAPI (`src/api/`, `src/server.ts`) |
| `area:infra`      | Terraform, k8s, Cloudflare, deploy, scheduler (`infra/`)            |
| `area:ci`         | CI workflows, quality gates, hooks (`.github/`, husky)              |
| `area:scripts`    | Tooling under `scripts/` (changelog, diagrams, insomnia)            |
| `area:docs`       | READMEs, ADRs, CLAUDE.md, RUNBOOK                                   |

## Axis 3 — Type

| Label         | Meaning                                      |
| ------------- | -------------------------------------------- |
| `enhancement` | New feature or user-facing improvement       |
| `bug`         | Something is broken                          |
| `refactor`    | Internal restructuring, no behavior change   |
| `chore`       | Build, deps, tooling, tests, CI, maintenance |

`good first issue` is an additional onboarding marker, applied alongside the type where it fits.

## Axis 4 — Priority

Assigned by rule at creation, **never hand-curated across the backlog** — that keeps it sustainable.

| Label             | Rule                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| `priority:high`   | Keystone that unblocks other issues, **or** a user-facing/production bug    |
| `priority:medium` | Default — normal feature or improvement work                                |
| `priority:low`    | Nice-to-have, cosmetic, exploratory, or "measure-first / likely thin yield" |

## The "next issue" queue (bookmark these)

Paste into the Issues search box, or bookmark the URL. This is how you pick the next thing to hand an
agent without scanning the whole backlog.

- **Primary — highest-priority ready work** (usually the keystones):
  `is:open label:"ready-for-agent" label:"priority:high" -label:"blocked"`
  → <https://github.com/macamp0328/liner-notes/issues?q=is%3Aopen+label%3A%22ready-for-agent%22+label%3A%22priority%3Ahigh%22+-label%3A%22blocked%22>
- **Full ready queue (oldest first)**:
  `is:open label:"ready-for-agent" -label:"blocked" sort:created-asc`
  → <https://github.com/macamp0328/liner-notes/issues?q=is%3Aopen+label%3A%22ready-for-agent%22+-label%3A%22blocked%22+sort%3Acreated-asc>
- **Needs me, not an agent**: `is:open label:"ready-for-human"`
- **Stuck (waiting on a dependency)**: `is:open label:"blocked"`
- **To triage (clear this bucket periodically)**: `is:open label:"needs-triage"`
- **Drift safety-net — should be empty** (any open issue missing a status label). Note `blocked` is
  deliberately _not_ excluded here: it's a modifier, so a `blocked`-only issue with no real status
  is drift and should surface.
  `is:open -label:"needs-triage" -label:"ready-for-agent" -label:"ready-for-human" -label:"needs-info" -label:"wontfix"`

Day-to-day: open the primary bookmark → take the top item → `/issue <url>`.

## Auto-apply rule (how it stays organized)

Whenever Claude Code **creates** an issue (via `/to-issues`, `/triage`, or an ad-hoc `gh issue
create`), it applies one `area:*` + one type + one status + one `priority:*`, plus `blocked` if the
body has a `## Blocked by` referencing an open issue. New issues that are fully specified and
agent-safe are born `ready-for-agent`; anything needing a maintainer call is born `needs-triage`.

When a keystone closes, its dependents stop being blocked — run `/triage` ("unblock dependents of
#N") to strip their `blocked` label.
