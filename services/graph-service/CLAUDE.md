# graph-service — Agent Handbook

## Service Purpose & Scope

`graph-service` is the core backend for liner-notes. It:

1. **Ingests** a Discogs vinyl collection into a Neo4j property graph
2. **Enriches** tracks with lyrics from LRCLIB (primary) and Genius (fallback)
3. **Serves** a Fastify REST API for relationship-driven collection exploration
4. **Auto-generates** OpenAPI documentation via `@fastify/swagger`

This is the **only service that talks to Neo4j**. All other services (future `collection-mcp`, etc.) query graph-service via REST.

---

## Discogs API Integration

> **Agent note:** Verify current rate limits and endpoint behavior against [live Discogs API docs](https://www.discogs.com/developers) before implementation. This section is a guide, not gospel.

**Base URL:** `https://api.discogs.com`  
**Auth:** Personal access token via `Authorization: Discogs token={DISCOGS_TOKEN}` header  
**Rate limits:** 60 req/min authenticated (verify against live docs)  
**User-Agent:** Required by Discogs terms — use `DISCOGS_USER_AGENT` env var

### Key Endpoints

| Endpoint                                              | Purpose                                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| `GET /users/{username}/collection/folders/0/releases` | All collection releases (paginated; folder 0 = all) |
| `GET /releases/{release_id}`                          | Full release — artists, labels, credits, tracklist  |
| `GET /artists/{artist_id}`                            | Artist — name, profile, aliases, members            |
| `GET /labels/{label_id}`                              | Label — name, parent, country                       |
| `GET /masters/{master_id}`                            | Master — canonical version grouping                 |

### Data Per Release

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

### Rate Limiting

- Configurable delay: `DISCOGS_REQUEST_DELAY_MS` (default 1000ms)
- Exponential backoff on 429 responses
- Log all rate limit hits
- Expected ingestion time: ~10–15 min for 200 records

### Known Gap: Studio Data

Studio data comes from `companies[]` where `entity_type` is `"23"` (Recorded At) or `"27"` (Mixed At). This field is **inconsistently populated** across the Discogs catalog — studio nodes will be sparse. This is expected and documented. Do not try to work around it.

> **Implementation note (Task 4):** Filter studios by the numeric `entity_type` code (`"23"` and `"27"`), **not** by `entity_type_name`. The name string is inconsistently capitalized/formatted across different Discogs entries (e.g. "Recorded At" vs "recorded at"). The numeric code is stable.

---

## Neo4j Graph Schema

> **Agent note:** Research Neo4j modeling best practices and validate against Task 2 API findings before implementing. Propose improvements explicitly.

### Nodes

| Label      | Key Properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Release`  | `discogsId` (unique), `title`, `pressingYear` (integer), `originalYear` (integer, nullable), `format`, `thumbUrl`, `masterDiscogsId`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Artist`   | `discogsId` (unique), `name`, `realName`, `profile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Label`    | `discogsId` (unique), `name`, `profile`, `contactInfo`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Track`    | `position` + `releaseDiscogsId` (composite MERGE key), `title`, `duration`, `lyrics` (nullable), `lyricsSource`, `lyricsFetchedAt` (datetime), `recordingMbid` (nullable), `isrc` (nullable), `musicBrainzFetchedAt` (datetime), `tempo` (nullable), `musicalKey` (nullable), `musicalScale` (nullable), `loudnessDb` (nullable), `dynamicComplexity` (nullable), `danceabilityEstimate` (nullable), `voiceInstrumental` (nullable), `acousticBrainzFetchedAt` (datetime), `deezerBpm` (nullable), `deezerGain` (nullable), `deezerFetchedAt` (datetime) |
| `Genre`    | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Style`    | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Country`  | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Studio`   | `name`, `location`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Musician` | `discogsId` (if available), `name` — the generic "credited person" node. Every credited contributor (performers, producers, engineers, …) is a `Musician`; the specific role lives on the `CREDITED_ON` edge (`roleCategory` / `displayRole`), not on a distinct node label.                                                                                                                                                                                                                                                                             |

> `pressingYear` is the year this specific pressing was manufactured (from Discogs `release.year`). `originalYear` is the year the album was first released anywhere, fetched from the Discogs master release endpoint and stored as a post-ingestion enrichment step. Queries that order or filter by release date should prefer `coalesce(r.originalYear, r.pressingYear)`.

### Relationships

| Relationship     | From → To                   | Properties                                                                                                                          |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASED_BY`    | Release → Artist            | `role`                                                                                                                              |
| `CREDITED_ON`    | Musician → Release or Track | `role`, `displayRole`, `roleCategory` (`"performer"`/`"producer"`/`"engineer"`/…), `creditedAs`, `scope` (`"release"` or `"track"`) |
| `ON_LABEL`       | Release → Label             | `catalogNumber`                                                                                                                     |
| `IN_GENRE`       | Release → Genre             |                                                                                                                                     |
| `IN_STYLE`       | Release → Style             |                                                                                                                                     |
| `FROM_COUNTRY`   | Release → Country           |                                                                                                                                     |
| `RECORDED_AT`    | Release → Studio            |                                                                                                                                     |
| `HAS_TRACK`      | Release → Track             | `trackNumber`                                                                                                                       |
| `PERFORMED_BY`   | Track → Artist              | `role`                                                                                                                              |
| `SAME_PERSON_AS` | Musician → Artist           |                                                                                                                                     |
| `MEMBER_OF`      | Artist → Artist             | `startYear`, `endYear`                                                                                                              |
| `SUBSIDIARY_OF`  | Label → Label               |                                                                                                                                     |
| `VERSION_OF`     | Release → Release           |                                                                                                                                     |

### Constraints & Indexes

```cypher
CREATE CONSTRAINT ON (r:Release) ASSERT r.discogsId IS UNIQUE;
CREATE CONSTRAINT ON (a:Artist) ASSERT a.discogsId IS UNIQUE;
CREATE CONSTRAINT ON (l:Label) ASSERT l.discogsId IS UNIQUE;
CREATE CONSTRAINT ON (g:Genre) ASSERT g.name IS UNIQUE;
CREATE CONSTRAINT ON (s:Style) ASSERT s.name IS UNIQUE;
CREATE CONSTRAINT ON (c:Country) ASSERT c.name IS UNIQUE;

CALL db.index.fulltext.createNodeIndex("trackLyrics", ["Track"], ["lyrics", "title"]);

CREATE INDEX ON :Release(pressingYear);
CREATE INDEX ON :Musician(name);
CREATE INDEX ON :Studio(name);
```

Apply these idempotently in `src/db/schema.ts`. Re-running must be safe.

---

## API Endpoints

### Collection

| Method | Path                          | Description                       |
| ------ | ----------------------------- | --------------------------------- |
| `GET`  | `/api/v1/releases`            | List releases, paginated          |
| `GET`  | `/api/v1/releases/:discogsId` | Single release with relationships |
| `GET`  | `/api/v1/artists/:discogsId`  | Artist with connected releases    |
| `GET`  | `/api/v1/labels/:discogsId`   | Label with all releases           |

### Exploration

| Method | Path                                     | Description                             |
| ------ | ---------------------------------------- | --------------------------------------- |
| `GET`  | `/api/v1/explore/musician/:name`         | Releases featuring this musician        |
| `GET`  | `/api/v1/explore/producer/:name`         | Releases this person produced           |
| `GET`  | `/api/v1/explore/engineer/:name`         | Releases this person engineered         |
| `GET`  | `/api/v1/explore/studio/:name`           | Releases at this studio                 |
| `GET`  | `/api/v1/explore/decade/:decade`         | Releases from this decade               |
| `GET`  | `/api/v1/explore/year/:year`             | Releases from this exact year           |
| `GET`  | `/api/v1/explore/label/:name`            | Releases on this label                  |
| `GET`  | `/api/v1/explore/genre/:name`            | Releases in this genre                  |
| `GET`  | `/api/v1/explore/style/:name`            | Releases in this style                  |
| `GET`  | `/api/v1/explore/country/:name`          | Releases from this country              |
| `GET`  | `/api/v1/explore/connections/:discogsId` | Graph traversal (`?depth=2`)            |
| `GET`  | `/api/v1/explore/shared-musicians`       | Release pairs sharing session musicians |

### Search

| Method | Path                       | Description                              |
| ------ | -------------------------- | ---------------------------------------- |
| `GET`  | `/api/v1/search?q=`        | Full-text across titles, artists, tracks |
| `GET`  | `/api/v1/search/lyrics?q=` | Full-text within lyrics                  |

### Admin & Ops

| Method | Path                          | Description                                |
| ------ | ----------------------------- | ------------------------------------------ |
| `POST` | `/api/v1/admin/ingest`        | Trigger ingestion (requires `ADMIN_TOKEN`) |
| `GET`  | `/api/v1/admin/ingest/status` | Last ingestion stats                       |
| `GET`  | `/api/v1/health`              | Service + Neo4j status                     |
| `GET`  | `/api/docs`                   | Swagger UI                                 |

### Response Shapes

```json
// List
{ "data": [...], "pagination": { "page": 1, "limit": 20, "total": 200 } }

// Single
{ "data": { ... } }

// Error
{ "error": { "code": "NOT_FOUND", "message": "Release not found" } }
```

---

## Ingestion Pipeline

```
1. Validate config (env vars, Neo4j connectivity, Discogs auth)
2. Apply schema (idempotent)
3. Fetch collection paginated via GET /users/{username}/collection/folders/0/releases
4. For each release:
   a. GET /releases/{release_id}
   b. Extract all entities
   c. MERGE all nodes and relationships
   d. Sleep DISCOGS_REQUEST_DELAY_MS
5. Lyrics enrichment:
   a. For each Track without lyrics → query LRCLIB
   b. Fallback to Genius API if LRCLIB returns nothing
   c. Update Track node with lyrics + lyricsSource
6. originalYear enrichment:
   a. For each Release where masterDiscogsId IS NOT NULL AND originalYear IS NULL
   b. GET /masters/{masterDiscogsId} → extract year field
   c. SET r.originalYear on the Release node
7. Log summary: nodes, relationships, lyrics enriched, originalYear enriched, errors, duration
```

**Triggers:**

- Auto on startup if no `Release` nodes exist in the graph
- Manual via `POST /api/v1/admin/ingest` (requires `ADMIN_TOKEN` header)

**Idempotency:** All writes use Cypher `MERGE`. Safe to re-run. New collection additions are picked up on re-run.

---

### Ingestion Implementation Notes (Task 4)

Added in Task 4. Source files:

- `src/ingestion/types.ts` — Discogs API TypeScript types
- `src/ingestion/transforms.ts` — Pure parsing/derivation functions (no I/O, fully unit-testable)
- `src/ingestion/discogs-client.ts` — `DiscogsClient` class with rate limiting and 429 backoff
- `src/ingestion/ingest.ts` — `runIngestion()` pipeline orchestrator + `buildDiscogsClientFromEnv()` helper
- `src/db/ingestion-repository.ts` — All Cypher MERGE queries; `hasReleases()` + `mergeReleaseGraph()`

**Non-obvious decisions:**

1. **Track node MERGE key uses `(position, releaseDiscogsId)` as a composite key stored as properties.** Neo4j has no unique constraint on Track (position alone is not globally unique — "A1" appears on thousands of releases). Storing `releaseDiscogsId` on the Track node makes each track uniquely identifiable without always needing the Release context. Changing these key properties will orphan existing Track nodes on re-ingest.

2. **Musicians with `id === 0` are merged by name only.** When `extraartists[n].id === 0`, the person is not in the Discogs database (catering staff, etc.). These are merged by `{name}` only — no `discogsId` is ever set on them. This is intentional; do not change it to merge by discogsId.

3. **Studio filter uses numeric entity_type codes.** `extractStudios()` in `transforms.ts` checks `entity_type === "23"` (Recorded At) and `entity_type === "27"` (Mixed At). Do not change to `entity_type_name` — the name string is unreliable across Discogs entries.

4. **Ingestion fires async without blocking `onReady`.** The pipeline takes ~4 min for 200 releases. Blocking `onReady` would delay the HTTP server from becoming ready and fail container liveness/readiness health checks. It is fired with `void runIngestion(...).then(...).catch(...)` intentionally.

5. **`CREDITED_ON` scope convention.** Relationships from a `Musician` to a `Release` use `scope: "release"`; to a `Track` use `scope: "track"`. The scope does **not** need to be part of the MERGE key because the relationship endpoint type (Release vs Track) already makes them distinct — but it is stored as a property for query convenience. Future explore-by-musician queries depend on `scope` being present.

6. **`anv` → `creditedAs`.** When `extraartists[n].anv` is non-empty, it is stored as `creditedAs` on the `CREDITED_ON` relationship. This captures sleeve credits where an artist used a different name (e.g. "Dom Monks" credited as "Dominic Monks"). When `anv` is empty string, `creditedAs` is `null`.

7. **MusicBrainz keys the release-group relation under `release_group` (underscore), not `release-group` (hyphen).** In the `/ws/2/url` relation JSON, the embedded entity is `release_group` and `target-type` is `"release_group"` — unlike the single-word `release` / `artist` keys, which have no hyphen/underscore ambiguity. Parsing it as `release-group` silently returns `null` for every master (the #183 no-op). Relatedly, the release **browse** endpoint (`/ws/2/release?release-group=…`) returns `release-events` by default and rejects `inc=release-events` as invalid — pass `inc=media` only to populate per-release formats.

**Regression guards — what breaks if you change X:**

| Change                                                                | Impact                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Modify `Track` MERGE key (`position`, `releaseDiscogsId`)             | Existing Track nodes become orphaned on re-ingest; HAS_TRACK relationships break                            |
| Remove `scope` from `CREDITED_ON` properties                          | Future explore-by-musician queries (Task 5+) that filter on scope stop working                              |
| Change `hasReleases()` query logic                                    | Auto-trigger decision changes; empty graph may not trigger, or non-empty may re-trigger                     |
| Reorder hooks in `server.ts` onReady                                  | `applySchema` must run before `hasReleases`; incorrect order causes schema not applied before first queries |
| Change studio `entity_type` filter from numeric codes to name strings | Studio filtering becomes unreliable across differently-formatted Discogs entries                            |

---

## OpenAPI / Swagger

Swagger UI is a **hard requirement** and must be available at `/api/docs`.

Use `@fastify/swagger` + `@fastify/swagger-ui`. Define JSON schemas on all route inputs/outputs. This enables:

- Auto-generated OpenAPI spec at `/api/docs/json`
- Interactive Swagger UI at `/api/docs`
- Type-safe request/response validation via Fastify's built-in ajv

---

## Testing

**Unit tests** (`tests/unit/`):

- Discogs response parsing and transformation
- Neo4j node/relationship builders
- Decade derivation from year
- Rate limiting and retry logic

**Integration tests** (`tests/integration/`):

- All API endpoints via Fastify's `inject()` against a test Neo4j instance
- Ingestion pipeline against mocked Discogs fixtures
- Full-text search on seed data
- Auto-ingest on empty graph

**Coverage requirements:**

- Unit: 70% minimum
- Integration: 100% of API routes covered

**Fixtures:** `tests/fixtures/` — JSON fixtures for mocked Discogs responses and seed data

**Run tests:**

```bash
pnpm test              # run all tests
pnpm test:coverage     # with coverage report
```

### Running integration tests locally

`pnpm --filter graph-service test:integration` runs `tests/integration/**` against
a **real** Neo4j instance (via `vitest.integration.config.ts`). It requires three
env vars — there is **no `NEO4J_*` fallback**, so a missing one fails the suite
fast, naming the var. An explicitly-set empty value is honored.

| Var                   | Local value (docker-compose Neo4j)                                                       |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `NEO4J_TEST_URI`      | `bolt://localhost:7687`                                                                  |
| `NEO4J_TEST_USER`     | `neo4j`                                                                                  |
| `NEO4J_TEST_PASSWORD` | empty — the compose Neo4j runs `NEO4J_AUTH=none`, and an explicitly-set empty is honored |

**dotenv-flow quirk:** Vitest sets `NODE_ENV=test`, and dotenv-flow deliberately
skips `.env.local` in that mode. Put the vars in `.env.test.local` (gitignored) or
export them in your shell — values in `.env.local` never reach the suite.

**Isolation:** the CI `neo4j:5` image and Neo4j Aura Free are both Community
edition, which supports only the single default database — `CREATE DATABASE test`
is unsupported. Tests isolate by instance plus a full graph wipe
(`MATCH (n) DETACH DELETE n`) between files, so point `NEO4J_TEST_*` at a database
you don't mind being cleared (the local docker-compose one is fine).

---

## Docker Build & Local Run

```bash
# Build context must be the repo root (Dockerfile copies workspace lockfile)
docker build -f services/graph-service/Dockerfile -t liner-notes/graph-service .

# Run standalone (needs .env.local with NEO4J_URI pointing to a running instance)
docker run -p 3000:3000 --env-file .env.local liner-notes/graph-service

# Or use docker-compose from repo root (preferred for local dev)
docker-compose up
```

---

## Architecture Notes

Keep Cypher query logic in a **repository layer** (`src/db/`) — not directly in route handlers. This keeps a future GraphQL layer addable without a route rewrite.

```
Route handler → Repository (Cypher) → Neo4j driver
```

---

## Module System

`graph-service` is ESM. Key rules for agents writing code in this service:

- **`"type": "module"`** is set in `package.json` — Node.js treats all `.js` output as ESM. Do not remove it.
- **`NodeNext` resolution** — TypeScript enforces `.js` extensions on all local imports. `from './db/client.js'` is correct; `from './db/client'` will error at compile time.
- **No `__dirname` / `__filename`** — these CJS globals are unavailable in ESM. If path resolution is needed, use:
  ```ts
  import { fileURLToPath } from 'url';
  import { dirname } from 'path';
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  ```
- **`esModuleInterop` removed** — it was removed to keep the config minimal and to avoid synthetic default imports that paper over module-format differences. With `NodeNext`, TypeScript uses each package's own declared types directly. For the rare CJS-only package that lacks a proper default export, use `import * as x from 'x'` or named imports rather than a synthetic default. Do not add `esModuleInterop` back.

---

## Known Limitations

- **Studio data is sparse.** `companies[]` in Discogs is inconsistently populated. `Studio` nodes will exist for only a fraction of releases. This is a data quality issue upstream, not a bug.
- **Musician/Artist deduplication is manual.** Session musicians and credited artists may be the same person with different Discogs IDs. Use `SAME_PERSON_AS` relationships to link them when discovered. No automated deduplication — this is a known tradeoff.
- **Lyrics are best-effort.** LRCLIB and Genius coverage is incomplete. Missing lyrics are acceptable — the `lyrics` property on `Track` is nullable by design.
- **Enrichment markers are `*FetchedAt` timestamps, not booleans (issue #89).** Every external-source enrichment stamps `<source>FetchedAt = datetime()` after each attempt. The candidate query selects a node only when it **still lacks the data** (e.g. `recordingMbid IS NULL`, `NOT EXISTS { (a)-[:ORIGIN_COUNTRY]->() }`, `lyrics IS NULL`) **and** its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30). So a node a source had no data for is retried at most once per window — picking up newly-added coverage or a fixed client without a full re-ingest — while already-enriched nodes are never re-fetched automatically. Transient errors don't stamp (they retry next run); the `/admin/<x>/reset` routes still force a full re-fetch. The marker is set server-side via `datetime()`, so there is no client-clock dependency. Helper: `src/enrichment/staleness.ts`.
- **No time signature from AcousticBrainz.** AcousticBrainz low-level rhythm descriptors do not expose a reliable categorical time signature. The `t.tempo` / `t.musicalKey` / `t.musicalScale` fields are trustworthy; a `time_signature` integer equivalent to Spotify's is not available without self-hosted Essentia analysis on the actual audio files.
- **AcousticBrainz audio features are estimates, not Spotify values.** `danceabilityEstimate` and `voiceInstrumental` are AcousticBrainz high-level classifier outputs — a different model trained on different data from Echo Nest/Spotify. They are labelled `...Estimate` deliberately and must never be presented as equivalent to Spotify features.
- **Deezer is an independent, ISRC-keyed audio-feature source.** `deezerBpm` and `deezerGain` (a loudness figure) are stored under `deezer*` property names rather than overwriting `tempo`/`loudnessDb`, so the source stays traceable and the two BPM figures can be compared. Deezer is an admin-route enrichment (not part of `runIngestion`) that depends on `isrc` being populated first by `track-musicbrainz` enrichment. Deezer returns `0` for unknown values — these are coerced to null before storing. `deezerGain` is a ReplayGain-style loudness figure; it is not the same metric as `loudnessDb`.
- **`formats[].qty` is a string in the API.** The Discogs API returns `qty` as a string (e.g. `"1"`), not a number. Always `parseInt` before storing. Do not assume it is numeric.
- **Track `duration` is frequently empty string.** The API returns `""` for tracks without listed duration. Treat `""` as null — do not store the empty string.
- **`basic_information` in collection responses is incomplete.** The collection endpoint's `basic_information` object omits `country`, `extraartists`, and other fields. Always fetch the full release via `GET /releases/{id}` before ingesting.
- **`CREDITED_ON` deduplication on re-run.** Because MERGE on a relationship between two nodes does not have a separate key — it matches by the full (from, type, to) pattern — re-running ingest updates relationship properties in-place. This is correct and intentional.
