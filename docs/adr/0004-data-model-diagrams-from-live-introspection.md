---
status: accepted
---

# Data-model diagrams: introspect the live graph, don't derive them from code

## Context

We have no easy-to-consume picture of the **data schema** — the Neo4j property graph (node labels,
relationship types, properties, constraints). The schema is documented three ways today, and all
three have gaps:

1. [`services/graph-service/src/db/schema.ts`](../../services/graph-service/src/db/schema.ts) — the
   executable, CI-validated source of truth, but it declares **only constraints and indexes**. Neo4j
   is schema-optional: labels, relationship types, and the vast majority of properties are
   _emergent_ from what the ingestion/enrichment code `MERGE`s, not declared anywhere. You cannot
   draw the real model from this file.
2. The node/relationship tables in
   [`services/graph-service/CLAUDE.md`](../../services/graph-service/CLAUDE.md) — a hand-maintained
   prose reference that already carries a "do not duplicate it here; it drifts" warning against
   `schema.ts`. It is the most complete model picture we have and the most likely to be wrong.
3. Scattered TypeScript interfaces (`src/db/repositories/*.ts`, `src/ingestion/types.ts`) — use-case
   slices (what one enrichment reads, what one route returns), never a whole-model definition.

The maintainer's goals: a **confident understanding of the graph as it actually is in production**,
and the ability to **see model changes** (a new label, a new property, a new relationship) as
reviewable diffs — without hand-maintaining a diagram and without a local checkout + `pnpm` command
to look at it.

We already have two diagram/artifact generators —
[`scripts/diagrams/`](../../scripts/diagrams) (Inframap/Mermaid of the AWS terraform resources) and
[`scripts/insomnia/`](../../scripts/insomnia) (OpenAPI + Insomnia collection) — both built on the
same pattern: **deterministic generation from committed source, run as a fail-on-drift PR check.**
The obvious instinct is to copy that pattern for the data schema. It does not transfer, for the
reason in point 1 above: there is no committed source that fully describes the graph. The only
complete, authoritative description of the model is **the running database itself.**

Neo4j exposes that description natively:

- `CALL db.schema.visualization()` — a graphical schema (label nodes + relationship edges) in Neo4j
  Browser. Interactive-only, shows no properties, and its relationship endpoints are inferred (often
  imprecise). Good for an ad-hoc look; unusable as a generator.
- `CALL apoc.meta.nodeTypeProperties()` / `apoc.meta.schema()` — machine-readable label/property/type
  metadata. **Confirmed available in the APOC Core subset on Aura** (including the Free tier we run).
  With `sample:-1` it is exhaustive and exact on a graph our size (~200 releases).
- `SHOW CONSTRAINTS` / `SHOW INDEXES` — the exact declared keys/indexes, to overlay onto the
  emergent picture and catch divergence from `schema.ts`.

## Decision

Generate the data-model documentation by **introspecting the live production graph**, and treat it
as a **non-deterministic snapshot artifact** — categorically different from our code-derived,
drift-gated generators. Concretely:

1. **The live graph is the source of truth, not code.** A `pnpm schema:diagram` script connects to a
   target Neo4j (default: prod read-only via `NEO4J_URI`; a local docker-compose DB works
   identically) and introspects it with three reads: `apoc.meta.nodeTypeProperties()` (`sample:-1`)
   for properties + types, an **exact connectivity query**
   (`MATCH (a)-[r]->(b) RETURN labels(a), type(r), labels(b)`) for relationship endpoints — we do
   _not_ trust apoc's edge inference — and `SHOW CONSTRAINTS`/`SHOW INDEXES` for key/index
   annotations.

2. **Two committed artifacts, both rendered.** Under `services/graph-service/docs/schema/`:
   `schema-er.mmd` (a property-rich Mermaid ER diagram: each label an entity with its properties,
   types, and key/index flags) and `schema-graph.mmd` (a graph-of-labels overview: labels as nodes,
   relationship types as edges — the at-a-glance view that mirrors `db.schema.visualization()`).
   Both are inlined into a `SCHEMA.md` between marker comments (the same inline-between-markers
   mechanism `request-flow.mmd` uses for the README/runbook), so they render graphically on
   github.com with no checkout.

3. **A structured snapshot is the machine-readable source of truth and the drift baseline.**
   `schema-snapshot.json` (sorted deterministically; **no node counts, no timestamps**) is committed
   alongside the diagrams. The diagrams are a pure `render()` of it. It is what the drift check diffs
   against, and what the hand-written CLAUDE.md tables are demoted to _pointing at_ (see consequence
   below).

4. **Drift is two exact, machine-readable comparisons — never prose-parsing.**
   - **Model drift:** current prod introspection vs the last committed `schema-snapshot.json` →
     added/removed labels, properties, and relationship types since the last accepted baseline. This
     is the "what changed" signal.
   - **Code↔DB drift:** prod `SHOW CONSTRAINTS`/`SHOW INDEXES` vs the constraints/indexes declared in
     `schema.ts` → a constraint that silently failed to apply, or a stray index in prod that code
     doesn't declare.

     The drift summary is written to `schema-drift.md` and into the refresh PR body. We deliberately
     do **not** parse the CLAUDE.md prose tables for drift — that is the brittle path; the structured
     snapshot replaces those tables as the authoritative model instead.

5. **It cannot be a PR drift-gate; it is a snapshot that opens a PR.** Because the output changes
   whenever the data changes the model — and because it requires live-DB credentials — it fails the
   two preconditions our other generators' CI gates rely on (determinism, no credentials). It is
   therefore modeled on the **changelog** (a scheduled producer of an artifact), not on
   `diagrams.yml` (a same-input drift check). `main` is protected by a ruleset that requires a PR and
   blocks direct pushes, so the automated refresh **opens/updates a PR** whose diff _is_ the model
   change and whose body carries the drift report. Merging accepts the new baseline. This PR review
   is the maintainer's "see changes before accepting them" surface.

6. **Credentials are pulled at runtime from Secrets Manager, never stored in GitHub.** The scheduled
   workflow assumes the existing OIDC AWS role (`AWS_DEPLOY_ROLE_ARN`) and reads
   `liner-notes/graph-service/prod` at run time. This requires granting that role
   `secretsmanager:GetSecretValue` on that secret (a small terraform change). Caveat: Aura Free is
   single-user, so the credential is write-capable; the script issues reads only.

7. **The job skips cleanly when the database is asleep.** Prod Aura auto-pauses when the k3s node is
   down (the stats-snapshot keep-warm only runs while the pod is up), and the instance can be
   powered off entirely. A scheduled run that cannot reach the DB logs "asleep, skipping" and exits 0
   — it never fails the workflow and never commits an empty/garbage diagram. The schedule is weekly
   with a `workflow_dispatch` manual fallback; an additional `workflow_run`-on-Deploy trigger is
   recommended (a deploy guarantees the DB is awake and is exactly when `schema.ts` changes land).

8. **A hosted GitHub Pages page supplements the in-repo render.** The same toolchain publishes a
   static HTML page (pinned Mermaid.js, pan/zoom, both views + last-updated + drift status) via
   `actions/deploy-pages`, deployed on `push` to `main` touching `docs/schema/**` — so the live page
   always reflects **merged/accepted** state, consistent with the PR-review model. Prerequisite:
   GitHub Pages from a **private** repo requires a paid plan (Pro/Team); on the Free plan the repo
   must be **public**. Either way the published page is public — acceptable because label/property/
   relationship _names_ are not sensitive under our public-repo safety rules.

9. **Determinism where it still matters.** The introspection is non-deterministic, but the
   `render()` and drift-compare functions are **pure and unit-tested** under the existing
   `script-tests` CI job (canned introspection JSON → asserted Mermaid + drift output, no DB
   needed). The snapshot/diagrams sort labels/properties/relationships and omit counts and
   timestamps, so re-running against an unchanged model produces a byte-identical artifact and the
   refresh job no-ops instead of opening a churn PR.

## Consequences

- **The CLAUDE.md node/relationship tables stop being a parallel source and become a pointer** to
  `docs/schema/`. This retires the duplication those tables already warn about, and directly serves
  the "not hand-maintained" goal — the authoritative model is now generated from prod, not typed by
  hand.
- **Two one-time prerequisites gate full rollout:** the terraform `secretsmanager:GetSecretValue`
  grant (Phase 3) and Pages enablement + repo-public-or-Pro (Phase 4). Phases 1–2 (the generator,
  diagrams, drift report, local `pnpm schema:diagram`) need neither and can land first, giving real
  generated output to validate before any automation or hosting is built.
- **A new dependency on `apoc.meta.*` being present on the target.** True on Aura and on the standard
  Neo4j Docker image we use locally/in CI; a fork on a stripped Neo4j without APOC would get a clear
  "APOC not available" error from the script, not silent wrong output.
- **The snapshot deliberately drops counts**, so the diagram answers "what is the shape of the graph"
  but not "how much data is in it." Cardinality/coverage already live in `/stats`; duplicating them
  here would only create commit churn. If a count view is ever wanted it belongs in a separate,
  uncommitted report.
- **The hosted page can briefly lag the PR-tracked source** (it deploys on merge to main, not on the
  refresh PR). This is intentional: the in-repo `SCHEMA.md` render is the review surface; the Pages
  page is the always-current view of accepted state.
- **This is the first repo tool that holds live prod credentials in an automated workflow.** The
  blast radius is contained by runtime-only secret retrieval (nothing in GitHub), read-only usage,
  and the CF/SG lockdown already in front of prod — but it is a genuinely new trust surface and is
  called out here so it is reviewed as one.

## Alternatives rejected

- **Code-derived generation (the `diagrams.yml`/`insomnia.yml` pattern).** Rejected because no
  committed file fully describes the graph — `schema.ts` is constraints/indexes only, and the model
  is emergent from the ingestion writers. A code-derived diagram would be perpetually incomplete and
  could never show "current prod state," the maintainer's primary goal.
- **`db.schema.visualization()` as the generator.** Rejected: interactive/Browser-only (not a
  committable artifact), shows no properties, and infers relationship endpoints imprecisely. Retained
  as the zero-build ad-hoc "deep dive" tool, not the pipeline.
- **A deterministic fail-on-drift PR check.** Impossible here — the output legitimately changes with
  the data and needs DB credentials, so it can be neither deterministic nor secret-free. Modeled on
  the changelog (scheduled producer) instead.
- **Auto-committing the refresh to `main`.** Blocked by the protection ruleset, and undesirable: the
  PR diff _is_ the value (reviewing model changes). The job opens a PR.
- **Parsing the CLAUDE.md prose tables for drift.** Brittle and self-defeating. The structured
  snapshot replaces those tables as the source of truth, so there is nothing prose to parse.
- **Storing prod Neo4j credentials as a GitHub secret.** Rejected in favor of runtime retrieval from
  Secrets Manager via the existing OIDC role — no long-lived DB credential lives in GitHub.
