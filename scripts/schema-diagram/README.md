# schema-diagram

Generates an **easy-to-consume picture of the live Neo4j data model** by introspecting a running
graph — node labels, properties + types, relationships, constraints, and indexes — and rendering it
to committed Mermaid diagrams + a JSON snapshot. See [ADR 0004](../../docs/adr/0004-data-model-diagrams-from-live-introspection.md)
for the why.

Unlike the code-derived generators (`diagrams:generate`, `insomnia:generate`), the source here is a
**live database**, because Neo4j is schema-optional: `src/db/schema.ts` declares only
constraints/indexes, while labels/properties/relationships are emergent from the ingestion writers.
The only complete, authoritative description of the model is the running graph itself. This makes the
tool non-deterministic w.r.t. the data and dependent on DB credentials — so it is **not** a
fail-on-drift CI gate; it's a scheduled producer that opens a PR (the changelog model, not the
diagrams model).

## Run it

```bash
# Against local docker-compose (APOC is enabled there; empty graph → empty diagram):
NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD= pnpm schema:diagram

# Against prod Aura (read-only) — creds from Secrets Manager liner-notes/graph-service/prod:
NEO4J_URI=neo4j+s://<host> NEO4J_USER=neo4j NEO4J_PASSWORD=<pw> pnpm schema:diagram
```

Outputs (committed, under `services/graph-service/docs/schema/`):

| File                   | What                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `schema-snapshot.json` | Canonical, sorted, count/timestamp-free model — the machine-readable contract + drift baseline. |
| `schema-er.mmd`        | Property-rich entity-relationship diagram (`PK` = unique key).                                  |
| `schema-graph.mmd`     | Graph-of-labels overview (the `db.schema.visualization()` analogue).                            |
| `SCHEMA.md`            | Renders both diagrams (Mermaid renders natively on github.com).                                 |

## How it works

Three reads against the target (after `verifyConnectivity`):

1. `CALL apoc.meta.nodeTypeProperties({sample: -1})` — exhaustive per-label properties + types.
2. `MATCH (a)-[r]->(b) RETURN labels(a), type(r), labels(b), count(*)` — **exact** relationship
   endpoints. `apoc.meta.schema()` is deliberately **not** used for edges: its edge inference is
   imprecise. The `count(*)` only groups/dedups and is dropped.
3. `SHOW CONSTRAINTS` / `SHOW INDEXES` — keys + index annotations (and `owningConstraint`, used by
   the PR2 drift report to ignore constraint-backed indexes).

The driver is built with `disableLosslessIntegers: true` so no `Integer {low,high}` blob can leak
into the JSON. Every list is sorted (including each property's `types`) and counts/ids/timestamps are
dropped, so a re-run on unchanged data is byte-identical — the scheduled refresh no-ops instead of
churning a PR.

When the DB is unreachable (Aura auto-paused / node powered off) the run is a clean no-op: it logs
and exits 0 without writing anything. A real failure (APOC missing, bad credentials) exits non-zero.

## Layout

| File            | Role                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `snapshot.ts`   | **Pure.** Canonical types + builders (rows → sorted snapshot). No driver. |
| `render.ts`     | **Pure.** Snapshot → Mermaid (ER + graph) + the SCHEMA.md inliner.        |
| `introspect.ts` | **I/O.** The only `neo4j-driver` importer: driver + the three reads.      |
| `generate.ts`   | Orchestrator + entry guard; the only file that writes artifacts.          |

Pure modules are driver-free so `pnpm scripts:test` (offline, no DB) never loads `neo4j-driver`.
Tests are canned-JSON only — APOC is enabled in `docker-compose.yml` but not in CI's Neo4j.
