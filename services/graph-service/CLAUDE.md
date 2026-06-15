# graph-service — Agent Handbook

## Service Purpose & Scope

`graph-service` is the core backend for liner-notes. It:

1. **Ingests** a Discogs vinyl collection into a Neo4j property graph
2. **Enriches** tracks with lyrics from LRCLIB (primary). Genius is a **local-only** fallback — the
   client is built only when `GENIUS_TOKEN` is set, and prod leaves it unset (#240/#258), so **prod is
   effectively LRCLIB-only**. See the Lyrics notes below before touching this.
3. **Serves** a Fastify REST API for relationship-driven collection exploration
4. **Auto-generates** OpenAPI documentation via `@fastify/swagger` (mounted in **dev only** — see OpenAPI / Swagger)

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
- Expected ingestion time: ~15–17 min for ~200 records (release load alone; enrichment runs separately)

### Known Gap: Studio Data

Studio data comes from `companies[]` where `entity_type` is `"23"` (Recorded At) or `"27"` (Mixed At). This field is **inconsistently populated** across the Discogs catalog — studio nodes will be sparse. This is expected and documented. Do not try to work around it.

> **Implementation note (Task 4):** Filter studios by the numeric `entity_type` code (`"23"` and `"27"`), **not** by `entity_type_name`. The name string is inconsistently capitalized/formatted across different Discogs entries (e.g. "Recorded At" vs "recorded at"). The numeric code is stable.

---

## Neo4j Graph Schema

> **Agent note:** Research Neo4j modeling best practices and validate against Task 2 API findings before implementing. Propose improvements explicitly.

### Nodes

| Label         | Key Properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Release`     | `discogsId` (unique), `title`, `pressingYear` (integer), `originalYear` (integer, nullable), `format`, `thumbUrl`, `masterDiscogsId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Artist`      | `discogsId` (unique), `name`, `realName`, `profile`, `genres[]`, `styles[]` (last two aggregated onto the Artist by the `artist-genres` enrichment), plus Wikidata-sourced (#341, set by `artist-wikidata`): `wikidataQid`, `bornYear`/`bornDate`, `diedYear`/`diedDate` (date string only at day precision), `imageUrl`, `awards[]`, `wikidataFetchedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Label`       | `discogsId` (unique), `name`, `profile`, `contactInfo`, `labelHierarchyFetchedAt` (datetime — set by the label-hierarchy enrichment, #332)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Track`       | `position` + `releaseDiscogsId` (composite MERGE key), `title`, `duration`, `durationSeconds` (integer, nullable), `lyrics` (nullable), `lyricsSource`, `lyricsStatus` (`resolved`/`instrumental`/`probable-instrumental`/`low-confidence`/`not-found`, nullable), `lyricsConfidence` (float 0–1, nullable), `lyricsMatchedTitle` (nullable), `lyricsMatchedArtist` (nullable), `lyricsFetchedAt` (datetime), `recordingMbid` (nullable), `isrc` (nullable), `musicBrainzFetchedAt` (datetime), `worksFetchedAt` (datetime — set by the track-works enrichment, #336), `tempo` (nullable), `musicalKey` (nullable), `musicalScale` (nullable), `loudnessDb` (nullable), `dynamicComplexity` (nullable), `danceabilityEstimate` (nullable), `voiceInstrumental` (nullable), `acousticBrainzFetchedAt` (datetime), `deezerBpm` (nullable), `deezerGain` (nullable), `deezerFetchedAt` (datetime) |
| `Genre`       | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Style`       | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Country`     | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Studio`      | `name`, `location`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Musician`    | `discogsId` (if available), `name` — the generic "credited person" node. Every credited contributor (performers, producers, engineers, …) is a `Musician`; the specific role lives on the `CREDITED_ON` edge (`roleCategory` / `displayRole`), not on a distinct node label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Master`      | `discogsId` (unique), `title`, `year`, `mbReleaseEventsFetchedAt` (datetime) — the canonical album grouping a `Release` is a pressing of. Holds the original-year + global pressing-country/format facts (see `RELEASED_IN` / `MB_RELEASED_IN`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Work`        | `mbid` (unique), `title`, `type` (MusicBrainz work type, e.g. `Song`), `writers` / `writerMbids` / `writerRoles` (index-aligned provenance arrays, `source: musicbrainz`, #336) — the **composition** (song as written), keyed on the MusicBrainz work MBID. A `Track` links to it via `RECORDING_OF`; two Tracks `RECORDING_OF` the same Work but different recordings are versions/covers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ReloadJob`   | `jobId` (unique), `status`, `startedAt`, `completedAt`, `durationMs` — one node per orchestrated reload run (#175), the checkpoint root. `finishReloadJob` prunes terminal (`complete`/`failed`) jobs beyond the newest `RELOAD_JOB_HISTORY_KEEP` (default 10) + their stages, so they don't accumulate; a `running`/resumable job is never pruned (#355).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ReloadStage` | `jobId` (indexed, **not** unique), `stage`, `ordinal`, `status`, `counts`, `error` — one per stage per job; linked from its `ReloadJob` by `HAS_STAGE`. Survives a pod restart so a killed reload resumes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> `pressingYear` is the year this specific pressing was manufactured (from Discogs `release.year`). `originalYear` is the year the album was first released anywhere, fetched from the Discogs master release endpoint and stored as a post-ingestion enrichment step. Queries that order or filter by release date should prefer `coalesce(r.originalYear, r.pressingYear)`.

### Relationships

| Relationship     | From → To                    | Properties                                                                                                                                                                                                                            |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASED_BY`    | Release → Artist             | `role`                                                                                                                                                                                                                                |
| `CREDITED_ON`    | Musician → Release or Track  | `role`, `displayRole`, `roleCategory` (`"performer"`/`"producer"`/`"engineer"`/…), `instrument` (normalized instrument family derived from `role`; `null` for non-instrument roles), `creditedAs`, `scope` (`"release"` or `"track"`) |
| `ON_LABEL`       | Release → Label              | `catalogNumber`                                                                                                                                                                                                                       |
| `PARENT_LABEL`   | Label → Label                | child → parent; the Discogs label hierarchy (#332). Populated by the label-hierarchy enrichment from `parent_label` (sublabels[] not ingested)                                                                                        |
| `IN_GENRE`       | Release → Genre              |                                                                                                                                                                                                                                       |
| `IN_STYLE`       | Release → Style              |                                                                                                                                                                                                                                       |
| `FROM_COUNTRY`   | Release → Country            |                                                                                                                                                                                                                                       |
| `RECORDED_AT`    | Release → Studio             |                                                                                                                                                                                                                                       |
| `HAS_TRACK`      | Release → Track              | `trackNumber`                                                                                                                                                                                                                         |
| `RECORDING_OF`   | Track → Work                 | `source` (`"musicbrainz"`) — the Track is a recording of this composition (#336), from MB recording→work relationships joined on `recordingMbid` by the `track-works` enrichment. Backs `GET /explore/work/:mbid`.                    |
| `SAME_PERSON_AS` | Musician → Artist            | by shared `discogsId` — written inline on ingest AND by the standalone `person-reconciliation` pass (#330, backfills late-Artist links)                                                                                               |
| `MEMBER_OF`      | Musician → Musician          | `active` (Boolean) — group membership from Discogs `/artists/{id}` `members[]`, written by the `group-members` pass (#330)                                                                                                            |
| `ORIGIN_COUNTRY` | Artist or Musician → Country | `source` (`"musicbrainz"` / `"wikidata"`; absent on edges written before the prop existed → surfaces as `untagged` in `/stats`)                                                                                                       |
| `RELEASED_IN`    | Master → Country             | `formats` — global pressing countries/formats from the Discogs master-data enrichment                                                                                                                                                 |
| `MB_RELEASED_IN` | Master → Country             | `mbReleaseId` (merge key), `date`, `formats` — release events from the MusicBrainz enrichment                                                                                                                                         |
| `HAS_STAGE`      | ReloadJob → ReloadStage      | `ordinal`                                                                                                                                                                                                                             |

### Constraints & Indexes

`src/db/schema.ts` is the **single source of truth** — it applies everything idempotently
(`IF NOT EXISTS`) on startup, in **Neo4j 5.x syntax**. Do **not** copy the old 3.x forms
(`CREATE CONSTRAINT ON … ASSERT …`, `db.index.fulltext.createNodeIndex(...)`) — Neo4j 5 / Aura / CI
reject them.

Uniqueness constraints:

```cypher
CREATE CONSTRAINT release_discogs_id IF NOT EXISTS FOR (r:Release) REQUIRE r.discogsId IS UNIQUE;
CREATE CONSTRAINT artist_discogs_id  IF NOT EXISTS FOR (a:Artist)  REQUIRE a.discogsId IS UNIQUE;
CREATE CONSTRAINT label_discogs_id   IF NOT EXISTS FOR (l:Label)   REQUIRE l.discogsId IS UNIQUE;
CREATE CONSTRAINT genre_name         IF NOT EXISTS FOR (g:Genre)   REQUIRE g.name IS UNIQUE;
CREATE CONSTRAINT style_name         IF NOT EXISTS FOR (s:Style)   REQUIRE s.name IS UNIQUE;
CREATE CONSTRAINT country_name       IF NOT EXISTS FOR (c:Country) REQUIRE c.name IS UNIQUE;
CREATE CONSTRAINT master_discogs_id  IF NOT EXISTS FOR (m:Master)  REQUIRE m.discogsId IS UNIQUE;
CREATE CONSTRAINT work_mbid           IF NOT EXISTS FOR (w:Work)    REQUIRE w.mbid IS UNIQUE;
CREATE CONSTRAINT reload_job_id      IF NOT EXISTS FOR (j:ReloadJob) REQUIRE j.jobId IS UNIQUE;
-- ReloadStage has a plain index on jobId, NOT a uniqueness constraint (many stages per job).
```

Full-text indexes (note **which route each backs** — the search routes do NOT use `trackLyrics`):

```cypher
-- backs GET /api/v1/search (db.index.fulltext.queryNodes("releaseArtistTrackSearch", …))
CREATE FULLTEXT INDEX releaseArtistTrackSearch IF NOT EXISTS FOR (n:Release|Artist|Track) ON EACH [n.title, n.name];
-- backs GET /api/v1/search/lyrics
CREATE FULLTEXT INDEX lyricsSearch IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics];
-- legacy lyrics+title index; retained but unused by the search routes
CREATE FULLTEXT INDEX trackLyrics IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics, t.title];
```

Plus range indexes on `Release.pressingYear`, `Musician.name`, `Studio.name`, the hot Track lookup
props (`isrc`, `recordingMbid`, `tempo`, `musicalScale`), and every `*FetchedAt` enrichment marker —
see `src/db/schema.ts` for the authoritative list (do not duplicate it here; it drifts).

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

All `/explore/*` routes return a **bare JSON array** — _not_ a `{ data }` envelope — except
`/explore/connections/:discogsId`, which returns `{ seed, nodes }`.

| Method | Path                                        | Description                                                                                                                                         |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/explore/musician/:name`            | Releases featuring this musician                                                                                                                    |
| `GET`  | `/api/v1/explore/producer/:name`            | Releases this person produced                                                                                                                       |
| `GET`  | `/api/v1/explore/engineer/:name`            | Releases this person engineered                                                                                                                     |
| `GET`  | `/api/v1/explore/instrument/:name`          | Musicians who play this normalized instrument (e.g. `bass`) and the releases — release-scoped (v1)                                                  |
| `GET`  | `/api/v1/explore/work/:mbid`                | Every recording of this MusicBrainz Work in the collection — "every version of this song I own" (#336); distinct `recordingMbid`s = versions/covers |
| `GET`  | `/api/v1/explore/studio/:name`              | Releases recorded at this studio                                                                                                                    |
| `GET`  | `/api/v1/explore/decade/:decade`            | Releases from this decade (accepts `1970s`)                                                                                                         |
| `GET`  | `/api/v1/explore/year/:year`                | Releases from this exact year                                                                                                                       |
| `GET`  | `/api/v1/explore/label/:name`               | Releases on this label (`?includeSublabels=true` rolls up the whole PARENT_LABEL family, #332)                                                      |
| `GET`  | `/api/v1/explore/genre/:name`               | Releases in this genre                                                                                                                              |
| `GET`  | `/api/v1/explore/style/:name`               | Releases in this style                                                                                                                              |
| `GET`  | `/api/v1/explore/country/:name`             | Releases from this country                                                                                                                          |
| `GET`  | `/api/v1/explore/connections/:discogsId`    | Graph traversal (`?depth=N`, max 3) — returns `{ seed, nodes }`                                                                                     |
| `GET`  | `/api/v1/explore/shared-musicians`          | Release pairs sharing session musicians                                                                                                             |
| `GET`  | `/api/v1/explore/tracks/most-international` | Tracks whose credited musicians span the most countries of origin (needs nationality enrichment)                                                    |
| `GET`  | `/api/v1/explore/releases/most-pressed`     | Releases with the widest global pressing reach (needs master-data enrichment)                                                                       |
| `GET`  | `/api/v1/explore/tracks/by-audio-features`  | Filter Tracks by audio features (tempo, key, scale, danceability, vocal/instrumental)                                                               |

### Search & Stats

| Method | Path                       | Description                                                                                                                                               |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/search?q=`        | Full-text across release/artist/track titles (`releaseArtistTrackSearch` index); bare array                                                               |
| `GET`  | `/api/v1/search/lyrics?q=` | Full-text within lyrics (`lyricsSearch` index); bare array                                                                                                |
| `GET`  | `/api/v1/stats`            | Public graph + enrichment-coverage stats (`{ data }`); short-TTL cached (the Aura keep-warm is the separate in-process snapshot timer, not this endpoint) |

### Admin & Ops

Every `/api/v1/admin/*` route requires `Authorization: Bearer <ADMIN_TOKEN>`
(`src/api/middleware/admin-auth.ts`) — a missing token yields `503 SERVICE_UNAVAILABLE`, a wrong one
`401 UNAUTHORIZED`. `/health` and `/stats` are public.

| Method | Path                                   | Description                                                                                       |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/admin/ingest`                 | Trigger the first-5-stage ingestion (release load + 4 enrichments; in-memory job state)           |
| `GET`  | `/api/v1/admin/ingest/status`          | Last ingestion stats                                                                              |
| `POST` | `/api/v1/admin/reload`                 | Orchestrated reload — every stage, DB-checkpointed & resumable (see below)                        |
| `GET`  | `/api/v1/admin/reload/status`          | Per-stage reload status/counts (DB-backed); a running job also carries `ageMs` + `stale` (#326)   |
| `POST` | `/api/v1/admin/reload/abort`           | Force a stuck `running` reload job (+ its running stages) terminal — operator escape hatch (#326) |
| `POST` | `/api/v1/admin/reset?confirm=wipe-all` | Wipe the whole graph (`MATCH (n) DETACH DELETE n`); guarded by the `confirm` query                |
| `POST` | `/api/v1/admin/lyrics/clear-genius`    | Clear Genius-sourced lyrics so they can be re-resolved                                            |
| `GET`  | `/api/v1/health`                       | Service + Neo4j status (public)                                                                   |
| `GET`  | `/api/docs`                            | Swagger UI — **dev only**, not mounted in production (see OpenAPI / Swagger)                      |

**Per-pipeline enrichment routes** are generated from the `PIPELINES` array in `admin.ts`. There are
**14** pipelines — `lyrics`, `nationality`, `master-data`, `mb-release-events`, `track-musicbrainz`,
`track-works` (#336, writes `RECORDING_OF` to MBID-keyed `Work` nodes from MB recording→work rels),
`track-acousticbrainz`, `track-deezer`, `artist-profiles`, `artist-genres`, `artist-wikidata` (#341,
resolves each Artist's `wikidataQid` via P1953/Wikipedia-URL and writes lifespan/image/awards),
`label-hierarchy` (#332, writes `PARENT_LABEL` from a per-Label `/labels/{id}` fetch), `group-members`
(#330, writes `MEMBER_OF` from a per-Musician `/artists/{id}` sweep), `person-reconciliation` (#330,
backfills `SAME_PERSON_AS`) — and for each:

- `POST /api/v1/admin/<stage>/enrich` — run that stage standalone (returns `202`; poll status). Four
  also run inside `runIngestion`; the rest are manual-only (see Ingestion Pipeline below).
- `GET /api/v1/admin/<stage>/status` — that stage's last-run counts / running flag.
- `POST /api/v1/admin/<stage>/reset` — force a full re-fetch. **Exists for 9 stages only** — the
  four _without_ a `reset` route are `lyrics` (use `/api/v1/admin/lyrics/clear-genius` instead),
  `master-data`, `artist-genres` (a self-idempotent whole-graph aggregation with nothing to reset),
  and `person-reconciliation` (re-links exhaustively every run — nothing to reset). `label-hierarchy`
  and `group-members` both _have_ a reset (label-hierarchy clears `labelHierarchyFetchedAt` + deletes
  PARENT_LABEL edges; group-members deletes every `MEMBER_OF` edge + clears `membersFetchedAt`);
  `artist-wikidata`'s reset clears `wikidataFetchedAt` + every Wikidata-sourced property.

### Response Shapes

Envelope cheat-sheet — read this before writing a client:

| Endpoint(s)                                             | Success shape           |
| ------------------------------------------------------- | ----------------------- |
| `releases`, `releases/:id`, `artists/:id`, `labels/:id` | `{ data, pagination? }` |
| `stats`                                                 | `{ data }`              |
| `explore/*` (except `connections`)                      | **bare array**          |
| `explore/connections/:discogsId`                        | `{ seed, nodes }`       |
| `search`, `search/lyrics`                               | **bare array**          |

```json
// List (collection)
{ "data": [...], "pagination": { "page": 1, "limit": 20, "total": 200, "totalPages": 10 } }

// Single
{ "data": { ... } }
```

**Errors come in two shapes — know which.** There is no custom `setErrorHandler`/`setNotFoundHandler`,
so:

- **Application errors** (a handler calls `reply.code(4xx).send(...)`) use the `{ error: { code, message } }`
  envelope — e.g. `404 NOT_FOUND`, `400 INVALID_DECADE` / `MISSING_QUERY` / `QUERY_TOO_LONG`,
  `401 UNAUTHORIZED`, `409 JOB_RUNNING` / `RELOAD_RUNNING` / `ENRICHMENT_RUNNING`,
  `503 SERVICE_UNAVAILABLE`.
- **Framework errors** (Fastify rejects before/around the handler) use Fastify's default
  `{ statusCode, error, message }` — schema-validation `400`s, unregistered-path `404`s, and
  rate-limit `429`s (`@fastify/rate-limit`).

A `400` or `404` can therefore be **either** shape depending on whether your code or Fastify rejected
the request (see #288).

```json
// Application error
{ "error": { "code": "NOT_FOUND", "message": "Release not found" } }

// Framework error (validation / unmatched route / rate-limit)
{ "statusCode": 400, "error": "Bad Request", "message": "params/discogsId must be integer" }
```

---

## Ingestion Pipeline

`runIngestion` (`src/ingestion/ingest.ts`) runs the **release load + 4 enrichments**. Each
enrichment runs in isolation — a throw is logged and recorded but does not abort the stages that
follow (#151).

```
1. Validate config (env vars, Neo4j connectivity, Discogs auth)
2. Apply schema (idempotent)
3. Fetch collection paginated via GET /users/{username}/collection/folders/0/releases, then for
   each release: GET /releases/{release_id} → extract entities → MERGE all nodes & relationships
   → sleep DISCOGS_REQUEST_DELAY_MS   (the shared `ingestReleases` loop)
   ── then the 4 enrichment stages ──
4. enrichLyrics        — Track without lyrics → LRCLIB (primary); Genius fallback only when
                         GENIUS_TOKEN is set (local/dev — prod is LRCLIB-only, #240/#258)
5. enrichMasterData    — Releases with a master → originalYear + global pressing countries/formats
                         (writes Master nodes + RELEASED_IN); replaces the old "originalYear" step
6. enrichArtistGenres  — aggregate genres/styles from Release nodes onto Artist nodes
7. enrichArtistProfiles — Artist realName + profile from the Discogs artist API
8. Log summary: nodes, relationships, per-enrichment counts, errors, duration
```

The 9 heavier/optional stages (`nationality`, `mb-release-events`, `track-musicbrainz`, `track-works`,
`track-acousticbrainz`, `track-deezer`, `label-hierarchy`, `group-members`, `person-reconciliation`)
are **not** in `runIngestion` — they're manual-only via the per-stage admin routes, or run as part of
the orchestrated reload below.

**Triggers:**

- Auto on startup if no `Release` nodes exist in the graph
- Manual via `POST /api/v1/admin/ingest` (requires `Authorization: Bearer <ADMIN_TOKEN>`)

**Idempotency:** All writes use Cypher `MERGE`. Safe to re-run. New collection additions are picked up on re-run.

---

### Orchestrated Reload (issue #175)

`POST /api/v1/admin/ingest` and the empty-graph auto-trigger only run the **first 4** enrichment stages
(lyrics, master-data, artist-genres, artist-profiles) and track state
**in memory** (`src/ingestion/job-state.ts`) — a pod crash loses it. The **orchestrated
reload** (`POST /api/v1/admin/reload`) owns the **whole** sequence and persists per-stage
state to Neo4j so it survives a restart.

Source files:

- `src/ingestion/stages.ts` — `RELOAD_STAGES`: the single source-of-truth definition. Each
  descriptor's `run` delegates to the existing `enrichX` function (one definition per stage) and
  declares `deps` (ordering prerequisites) + `resources` (mutual-exclusion lanes). The array is in
  **priority** order (cheap + #165-gate stages first), which is also a valid topological sort;
  actual run order is governed by `deps`, not array position. `verify` is the final **coverage
  gate** (#178) — its descriptor `run` is a no-op; the gate logic lives in the orchestrator's
  `runVerifyGate` (it needs cross-stage `ranStages`), and its derived deps keep it strictly last.
- `src/ingestion/scheduler.ts` — `scheduleStages`: the generic bounded-concurrency, dependency- and
  resource-aware scheduler (no Neo4j/job-repo imports) plus `validateStageGraph` (test-only DAG
  guard). See "Scheduling (#176)" below.
- `src/ingestion/orchestrator.ts` — `runReload(driver, { username, logger?, resumeJobId?, concurrency? })`
  and `buildReloadContext()`. Drives `scheduleStages` over `RELOAD_STAGES`, special-cases `verify`
  via `runVerifyGate`, skipping stages already
  `complete`/`skipped`, and persists each transition.
- `src/ingestion/reload-verify.ts` — the coverage-gate thresholds and pure comparison logic.
  `RELOAD_COVERAGE_THRESHOLDS` is the one place the bars live; `evaluateCoverage(stats,
ranStages)` produces a structured per-metric pass/fail report reused by the gate and its tests.
- `src/db/job-repository.ts` — `ReloadJob`/`ReloadStage` persistence (one job per run;
  `findResumableReloadJob` returns the latest still-`running` job — the resume signal).
- `src/db/schema.ts` — `ReloadJob` constraint + indexes.

**Semantics:**

- **Scheduling (#176).** Stages run with **bounded concurrency** (`RELOAD_STAGE_CONCURRENCY`, env;
  code default 2, clamped to `[1, stage count]`; `1` = legacy strictly-sequential). **Prod overrides
  this to 3 via the k8s deployment manifest (#370)** so the untagged `lyrics` stage overlaps the
  serial Discogs chain instead of waiting ~1h for a slot; the code default stays 2 (conservative for
  forks/local on weaker hardware). Caveat: raising concurrency does **not** move `nationality`
  earlier — it holds the `discogs` lane (see `resources` below), so it can't start until the whole
  Discogs chain releases that lane and therefore stays the reload tail regardless of the cap. Two
  ordering rules govern the schedule, both data on `StageDescriptor`:
  - **`deps`** — a stage starts only once every dep has reached a terminal state (complete/skipped/
    failed; an ordering edge, not a success gate). Load-bearing edges: every enrichment deps
    `releases`; `mb-release-events` deps `master-data` (it `MATCH`es the Master nodes only
    master-data creates); `track-acousticbrainz`/`track-deezer` dep `track-musicbrainz`;
    `person-reconciliation` deps `artist-genres` **and** `group-members` (#330 — see the lane note:
    deps double as the deadlock guard for the one dual-axis writer).
  - **`resources`** — stages sharing a lane never overlap. `discogs`/`musicbrainz`/`wikidata` guard
    the **shared HTTP client's rate limiter** (the clients have no shared request queue, so two
    concurrent stages on one would double the request rate — every client user carries its tag; the
    `wikidata` lane (#341) serialises `nationality` and `artist-wikidata`, which share `ctx.wikidata`).
    `track` serialises the three **batched** Track writers (`track-musicbrainz`,
    `track-acousticbrainz`, `track-deezer`): a Neo4j deadlock needs two transactions each holding-
    and-waiting on ≥2 nodes, so it is only possible between two batched writers of the same label.
    **`lyrics` writes one Track per transaction (deadlock-immune) and is intentionally untagged**,
    free to overlap the batched lane — _if it ever moves to a batched write, give it the `track`
    tag._ There is no `artist`/`musician` node-lock lane: `artist-genres` is the only batched
    **Artist** writer and `group-members` the only batched **Musician** writer (#330) — disjoint
    labels, so they may overlap. The one writer spanning **both** axes, `person-reconciliation` (its
    single `MERGE` locks Musician + Artist), must not overlap either, and is serialized after both
    via `deps` rather than a lane — cheaper than adding two lanes, since those two never conflict.
    `group-members` itself only contends with reconciliation (handled by that dep), so it carries no
    node-lock lane (just `discogs` for the rate limiter). Net effect: the #165 gate stages finish in
    the first minutes
    while the slow `lyrics`/`track-musicbrainz` run on their own lanes.
- **Resume, not restart.** On `POST /reload` and on **cold start** (`server.ts` onReady, after
  the `autoIngest` guard), a still-`running` job is resumed from where it left off. A
  killed-mid-reload pod continues; it does **not** re-wipe or skip-because-non-empty. With
  concurrency > 1 a crash can leave **several** stages `running` — all re-run idempotently (each
  stage's candidate filters pick up only unfinished work).
- **Stage outcomes:** a `run` returning a counts map → `complete`; returning `null` (its
  client was unconfigured) → `skipped`; throwing → `failed`, logged, and the run continues
  (failure isolation). The job ends `failed` if any stage failed, else `complete` — only a
  still-`running` job auto-resumes, so a `failed`/`complete` job never retries on every boot.
- **Verify gate (#178).** The final `verify` stage compares graph coverage (via `getStats`)
  against `RELOAD_COVERAGE_THRESHOLDS`, gating a metric only when its producing stage actually
  ran this job (so a skipped stage's metric is exempt, not a false silently-zero). A metric that
  is silently-zero (`applicable>0, covered=0`) or below its floor fails the reload `failed` and
  logs at pino level ≥ 50; the per-metric report is persisted on the verify stage's `counts`
  (and `error` on failure), surfaced by `/admin/reload/status`. An empty graph fails the gate.
- **Wipe stays separate.** The reload never wipes; run `POST /reset?confirm=wipe-all` first for
  a from-scratch reload. It picks up from empty-or-partial.
- **Cross-job mutual exclusion (#281, #300).** Every mutating admin route enforces "only one
  graph-writing job at a time" against three in-memory, **synchronous** signals: the `/ingest` job
  (`getJobState().status === 'running'`, `job-state.ts`), the reload-active flag
  (`isReloadActive()`, `reload-progress.ts`), and the per-pipeline running flags
  (`PIPELINES[n].state.running`). They all contend on the same rate-limited Discogs/MusicBrainz
  clients (`runIngestion` itself enriches), so the helper `busyWith(ignore?)` in `admin.ts` checks
  all three and returns the 409 to send (or null); each route passes `ignore` to skip the signal it
  guards itself with a richer 409. Coverage:
  - `/reload` 409s `RELOAD_RUNNING` (with jobId, from the DB `findResumableReloadJob`) against
    another reload, and via `busyWith({ reload: true })` 409s `JOB_RUNNING` / `ENRICHMENT_RUNNING`
    (naming the stage) against an `/ingest` job or a standalone enrich — the sync check
    short-circuits before the Neo4j round-trip.
  - `/<stage>/enrich` keeps its synchronous `isReloadActive()` `RELOAD_RUNNING` guard (not
    `getLiveProgress()`, which is null between stages) and its per-pipeline `ENRICHMENT_RUNNING`
    guard, and adds `busyWith({ reload: true, enrich: true })` to 409 `JOB_RUNNING` against an
    ingest job. `ignore.enrich` is deliberate: a _different_ enrich stage may run concurrently (the
    #176 lanes overlap); this stage's own contention is the per-pipeline flag.
  - `/ingest` keeps its `JOB_RUNNING` (with jobId) guard and adds `busyWith({ ingest: true })` to
    409 against a reload or any enrich.
  - `/<stage>/reset` adds `busyWith({ enrich: true })` (reload + ingest) above its own per-pipeline
    guard; `/reset?confirm=wipe-all` and `/lyrics/clear-genius` (which own no flag) call
    `busyWith()` against all three after their own gates (the wipe `confirm` 400 still precedes it).
    `/reset` _additionally_ 409s `RELOAD_RUNNING` on a DB-`running` reload job (`findResumableReloadJob`,
    not just the in-memory flag), so a wipe can't DETACH DELETE the `ReloadJob`/`ReloadStage`
    checkpoints of a reload no live pod is currently on — a crash not yet resumed, or a cold-start
    resume skipped for missing creds (#290). `/reload` sets `markReloadActive(jobId)` **synchronously
    before its 202** (not only inside `runReload`, which marks it after awaiting job-state reads —
    that left a window where an enrich fired right after a reload would slip through); the handler's
    `.catch` clears the in-memory flag if `runReload` rejects before its own `finally`, and also
    best-effort `finishReloadJob(jobId, 'failed')`s so an orchestration that rejected outside any
    stage's catch can't sit `running` forever and 409 every future `/reload`+`/reset` until a pod
    restart (#290). All three signals being synchronous is load-bearing: `busyWith` adds no `await`
    before any atomic `running = true` set. The remaining residual is the single-tick interleave where
    a job starts _between_ another route's check and its flag set — irreducible without a lock, and
    harmless since writes are MERGE-idempotent; these checks close the operator-error window, not every
    interleave. (#177 was rescoped to deploy⇄reload and closed; #281 owned reload⇄enrich, #300 extended
    it to `/ingest` and the reset routes; #290 added the `/reset` DB-resumable guard + the rejected-
    reload `failed` recovery.)
- **Stuck-job detection + abort (#326).** #290 left a tail: a job can be `running` in Neo4j with
  **no live pod** on it (`isReloadActive()` false) — a cold-start resume skipped for missing creds,
  or a crash whose `.catch` recovery never fired — and #323's guards then 409 every `/reload` +
  `/reset` until a pod restart. Two complements close it without a restart:
  - **Detect.** `GET /reload/status` adds `ageMs` (the job's age, computed **server-side** via
    `getReloadJobAgeMs` = `datetime().epochMillis - j.startedAt.epochMillis`, never `Date.parse`-ing
    the 9-fractional-digit `startedAt`) and `stale` — `true` for a `running` job older than
    `RELOAD_STALE_AFTER_HOURS` (default 12) with **no live pod** (`!isReloadActive()`). `stale`
    requires `!isActive`, so a legitimately-long live run is never flagged; a _freshly_ stuck job
    (age below the threshold) is correctly not yet `stale` — `stale` is the discovery aid, not the
    gate. The pure `reloadStaleness(job, isActive, ageMs, staleAfterMs)` helper in `admin.ts`.
  - **Act.** `POST /reload/abort` → `abortReloadJob(jobId)` marks the job + any of its `running`
    stages `failed` in one atomic Cypher (`count(DISTINCT j)` — the `OPTIONAL MATCH` over running
    stages multiplies the job row). It 404s `NO_RELOAD_RUNNING` when nothing is resumable and 409s
    `RELOAD_RUNNING` when a reload is **actively running on this pod** (the in-process scheduler
    can't be safely interrupted — restart the pod to interrupt a live reload; it resumes from its
    last completed stage via the cold-start path). Asymmetry vs `/reset`, which refuses on _either_
    signal: abort refuses on the in-memory live signal and _acts_ on the DB-only stuck signal.
    **Not** gated by `busyWith()` — it mutates only `ReloadJob`/`ReloadStage` checkpoint nodes,
    never graph data. Pairs with `/reset`: abort the stuck job, then wipe.
- **`ingestReleases`** (in `ingest.ts`) is the shared release fetch/MERGE loop used by both the
  legacy `runIngestion` and the reload's `releases` stage — one definition, no drift.

---

### Enrichment runner (issue #222)

`src/enrichment/run.ts` owns the per-item enrichment loop invariants — staleness-windowed
candidate selection (delegated to each repo's query), per-item failure isolation, the
stamp-on-attempt contract, progress reporting (`onProgress` + a `Progress: i/total` info line
every `progressEveryItems`, default 25; the slow ~1 item/s stages declare 10), and summary
aggregation. Each pipeline is a thin `EnrichmentStage` declaring only what varies.

**The four-outcome `resolve()` contract (#89, #367).** `resolve()` returns one of four things,
and the runner maps each to a write and a counter:

- **data** → `write` persists it + stamps `*FetchedAt`, counted `enriched`.
- **`null`** (queried, no data, but it could appear later) → `markAttempted` stamps `*FetchedAt`,
  counted `skipped` — re-checked at most once per staleness window (**throttled-recheck**).
- **`TERMINAL_EMPTY`** (queried, definitively & permanently no data) → `markTerminal` writes a
  **permanent marker** so the candidate query excludes it for good, counted `exhausted`
  (**terminal-empty**, #367).
- **throws** (transient) → no stamp, counted `failed`, retried next run. The loop never aborts
  siblings.

`markAttempted`/`markTerminal` are both **optional** — a stage declares only the outcomes its
`resolve` produces (e.g. `group-members` omits `markAttempted` because a no-members result is
always terminal). Returning an outcome whose handler is absent **throws into `failed`** (loud,
isolated) rather than silently degrading terminal→throttle. Terminal is **opt-in per value,
throttle-only is the default**; the candidate query excludes the marker with a null-safe boolean
`<marker> IS NULL` gate. `lyrics` keeps its richer `lyricsStatus` enum (it is a superset of the
generic mechanism — see ADR 0001); `group-members` is the canonical generic consumer. Full
rationale + per-source audit in [ADR 0003](../../docs/adr/0003-enrichment-terminal-vs-throttle.md).

**Per-item concurrency (#247).** `runEnrichment` takes an optional `concurrency` (default `1` →
strictly serial, byte-for-byte the original loop) that bounds how many items process at once via a
shared-index worker pool. Counters are mutated synchronously between awaits, so the single-threaded
event loop keeps them race-free; under concurrency the progress line keys off completion count, not
arrival order. **Only `lyrics` opts in today** (`LYRICS_CONCURRENCY`, default 6, clamped `[1, 12]`),
and only because it is deadlock-immune — it writes one Track per transaction, so it carries no
resource lane (see "Scheduling (#176)"). Bounded concurrency IS the lyrics stage's rate ceiling
(there is no separate limiter), so `LYRICS_CONCURRENCY` doubles as the politeness knob toward LRCLIB.
It composes with the stage-level `RELOAD_STAGE_CONCURRENCY` (intra-stage workers inside one stage
slot). Do not enable it for a stage on a shared rate-limited client lane — concurrent items would
bypass that client's per-call spacing. Inside the orchestrated reload the lyrics stage instead uses
`resolveReloadLyricsConcurrency()` → `RELOAD_LYRICS_CONCURRENCY` (falls back to `LYRICS_CONCURRENCY`
when unset), a reload-only throttle (#372) for the contended path that leaves standalone
`/lyrics/enrich` runs at the full `LYRICS_CONCURRENCY`.

**Runs through the runner:** `lyrics`, `artist-profiles`, `master-data`, `mb-release-events`,
`track-musicbrainz` (item = release, one stamping write per release), and `nationality` (two
sequential stages — Artists then Musicians — sharing source-instrumentation closures).

**Deliberate exceptions** (documented in their file headers): `track-deezer` and
`track-acousticbrainz` keep hand-rolled loops — their fetch/write/failure semantics are
batch-scoped (per-ISRC fan-out with 50-track write flushes; bulk 100-MBID API calls), which
the per-item contract cannot express without losing the batching. `artist-genres` is a pure
whole-graph Cypher aggregation with no candidate loop or stamping. Do not force-fit these
onto `EnrichmentStage`.

---

### Ingestion Implementation Notes (Task 4)

Added in Task 4. Source files:

- `src/ingestion/types.ts` — Discogs API TypeScript types
- `src/ingestion/transforms.ts` — Pure parsing/derivation functions (no I/O, fully unit-testable)
- `src/ingestion/discogs-client.ts` — `DiscogsClient` class with rate limiting and 429 backoff
- `src/ingestion/ingest.ts` — `runIngestion()` pipeline orchestrator + `buildDiscogsClientFromEnv()` helper
- `src/db/ingestion-repository.ts` — All Cypher MERGE queries; `hasReleases()` + `mergeReleaseGraph()`

> **Lyrics clients (#247):** `src/ingestion/lrclib-client.ts` (`LrclibClient`) and
> `src/ingestion/genius-client.ts` (`GeniusClient`) join the other external clients here — every
> HTTP client lives in `src/ingestion/`, even the enrichment-consumed ones (deezer, acousticbrainz,
> wikidata). Both share the `createRateLimitedFetch` core (retry/backoff/UA) like the rest. LRCLIB
> sends an identifying UA (`LRCLIB_USER_AGENT`); Genius keeps the browser UA (#195/#236) and 403 is
> deliberately **not** retried (permanent Cloudflare datacenter block → an expected `GeniusHttpError`).
> `GeniusClient` is the integration surface for the circuit breaker (#242). `enrichLyrics` accepts an
> optional injected-clients param (the breaker seam + unit-test seam); it defaults to the
> `build*ClientFromEnv` factories.

**Non-obvious decisions:**

1. **Track node MERGE key uses `(position, releaseDiscogsId)` as a composite key stored as properties.** Neo4j has no unique constraint on Track (position alone is not globally unique — "A1" appears on thousands of releases). Storing `releaseDiscogsId` on the Track node makes each track uniquely identifiable without always needing the Release context. Changing these key properties will orphan existing Track nodes on re-ingest.

2. **Musicians with `id === 0` are merged by name only.** When `extraartists[n].id === 0`, the person is not in the Discogs database (catering staff, etc.). These are merged by `{name}` only — no `discogsId` is ever set on them. This is intentional; do not change it to merge by discogsId.

3. **Studio filter uses numeric entity_type codes.** `extractStudios()` in `transforms.ts` checks `entity_type === "23"` (Recorded At) and `entity_type === "27"` (Mixed At). Do not change to `entity_type_name` — the name string is unreliable across Discogs entries.

4. **Ingestion fires async without blocking `onReady`.** The release load takes ~15–17 min for ~200 releases (measured 2026-06-13: 196 releases at ~5s/release). Blocking `onReady` would delay the HTTP server from becoming ready and fail container liveness/readiness health checks. It is fired with `void runIngestion(...).then(...).catch(...)` intentionally.

5. **`CREDITED_ON` scope convention.** Relationships from a `Musician` to a `Release` use `scope: "release"`; to a `Track` use `scope: "track"`. The scope does **not** need to be part of the MERGE key because the relationship endpoint type (Release vs Track) already makes them distinct — but it is stored as a property for query convenience. Future explore-by-musician queries depend on `scope` being present.

6. **`anv` → `creditedAs`.** When `extraartists[n].anv` is non-empty, it is stored as `creditedAs` on the `CREDITED_ON` relationship. This captures sleeve credits where an artist used a different name (e.g. "Dom Monks" credited as "Dominic Monks"). When `anv` is empty string, `creditedAs` is `null`.

7. **MusicBrainz keys the release-group relation under `release_group` (underscore), not `release-group` (hyphen).** In the `/ws/2/url` relation JSON, the embedded entity is `release_group` and `target-type` is `"release_group"` — unlike the single-word `release` / `artist` keys, which have no hyphen/underscore ambiguity. Parsing it as `release-group` silently returns `null` for every master (the #183 no-op). Relatedly, the release **browse** endpoint (`/ws/2/release?release-group=…`) returns `release-events` by default and rejects `inc=release-events` as invalid — pass `inc=media` only to populate per-release formats.

8. **`instrument` is a derived, separate `CREDITED_ON` property (#333).** `parseInstrument(role)` in `transforms.ts` normalizes the free-text Discogs role onto a controlled 25-family vocabulary (`bass`, `guitar`, …) so credit queries don't enumerate every spelling. The raw `role` and first-token `displayRole` are kept verbatim for provenance — `instrument` never overwrites them. It is **not** gated on `roleCategory === 'performer'`: the role-category performer keyword list is narrower than the instrument vocabulary, so gating would silently null real instruments (`Trombone`, `Viola`, `Clarinet`, `Vibraphone` all bucket as `roleCategory: 'other'`). Non-instrument roles (producers, engineers, visual, crew) store `instrument = null`. `INSTRUMENT_RULES` is priority-ordered and the order is load-bearing (drums/clarinet before bass, vibraphone before percussion, bowed before strings, harmonica before harp) — see the comment on the table. Backs `GET /api/v1/explore/instrument/:name`.

9. **`Work` cover/version model is MBID-keyed; writers are captured, not yet edges (#336).** `(:Work {mbid})` + `(:Track)-[:RECORDING_OF]->(:Work)` are populated **only** from MusicBrainz recording→work relationships joined on the `recordingMbid` we already store — never title/fuzzy matching (the #185/#250 lesson: title matching only ever finds same-recording duplicates). Covers/versions are a derived query (`GET /explore/work/:mbid`), not a stored heuristic — two Tracks `RECORDING_OF` the same Work but different recordings are versions; the same recording reissued is a duplicate. Composer/lyricist/writer credits **are** fetched (`/work/{mbid}?inc=artist-rels`) but stored as **provenance arrays on the Work** (`writers`/`writerMbids`/`writerRoles`), **not** as `(:Musician)-[:WROTE]->(:Work)` edges: MB returns writers by MB-artist MBID, our Musicians are Discogs-keyed, and there is no Discogs↔MB-artist mapping yet, so a deterministic edge isn't possible without name-matching (forbidden). Promoting these arrays to real `WROTE` edges (via an identity reconciliation that needs **zero** new MB calls — the MBIDs are already captured) is a deliberate follow-up.

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

Swagger UI is **dev-only by design** — `server.ts` registers `@fastify/swagger` +
`@fastify/swagger-ui` only when `NODE_ENV !== 'production'`. In production **neither `/api/docs` nor
`/api/docs/json` is mounted** (a request gets a `404`). The gate rides the same `NODE_ENV` switch as
helmet's CSP: Swagger UI's inline scripts/styles need CSP disabled, so the full helmet defaults stay
on in prod and Swagger stays off. Do not "fix" the missing prod docs route — it's intentional.

Define JSON schemas on all route inputs/outputs regardless — they drive the committed `openapi.json`
/ Insomnia collection (regenerated by `pnpm insomnia:generate`, drift-checked in CI) and Fastify's
ajv request/response validation. In dev this also enables:

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
- Integration: 100% of API routes covered — enforced by `tests/integration/api/route-coverage.test.ts`,
  which diffs the live Fastify route table (`buildDocsServer().swagger()`) against the `/api/...` paths
  the integration suite actually references and fails naming any route no integration test exercises.

**Fixtures:** `tests/fixtures/` — JSON fixtures for mocked Discogs responses and seed data

**Shared helpers:** `tests/helpers/` — cross-suite test utilities (e.g. `env.ts`'s `snapshotEnv(keys)` for save/restore of `process.env` around a suite). Lives under `tests/`, never imported by `src/`.

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

**Isolation:** both the CI `neo4j:5.26` image (Community edition) and Neo4j Aura Free
support only the single default database — `CREATE DATABASE test` is unsupported on
either. Tests isolate by instance plus a full graph wipe
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
- **Musician/Artist resolution is by shared `discogsId`, not fuzzy matching (#330).** A person credited as a session `Musician` and listed as a primary `Artist` is linked via `SAME_PERSON_AS` when they share a `discogsId` — written inline on ingest and backfilled exhaustively by the standalone `person-reconciliation` pass (so late-arriving Artist nodes get linked without a re-ingest). Group membership (`MEMBER_OF`) comes from Discogs `members[]` via the `group-members` pass. The explore queries (`getReleasesByMusician`, `getSharedMusicians`) traverse these edges to consolidate aliases; `getReleasesByMusician` also expands `MEMBER_OF` **one way only** — a member's results include their group's records (an inferred, temporally-unguarded involvement), but a group query is NOT expanded to its members' solo credits (which would over-attribute the group — PR #330 review). `/stats.samePersonLinks` (verify-gated at 100%) + `memberOfEdges`/`groupsWithMembers` make the result measurable. **Still unresolved:** name-only (`id === 0`) credits carry no `discogsId`, so they don't collapse — that needs Discogs `namevariations` (a deliberate follow-up). There is no fuzzy name matching by design.
- **Lyrics are best-effort.** LRCLIB and Genius coverage is incomplete. Missing lyrics are acceptable — the `lyrics` property on `Track` is nullable by design.
- **Lyrics resolution is a five-state, confidence-gated model (issues #246, #248).** `lyricsStatus ∈ {resolved, instrumental, probable-instrumental, low-confidence, not-found}` distinguishes "no lyrics exist" from "we missed them" from "we found the wrong song". `instrumental` (LRCLIB's authoritative flag) and `probable-instrumental` (the AcousticBrainz `voiceInstrumental` signal we already store) are **terminal** — excluded from the candidate query and short-circuited before any Genius call, killing the wasted-call/403-spam loop. `not-found` and `low-confidence` stay candidates, throttled per staleness window. `probable-instrumental` depends on `track-acousticbrainz` having run first, which finishes after `lyrics` in a fresh reload — so it mostly classifies on a later staleness re-run (lyrics is deliberately not made a dep of that ~2.5hr stage). `/stats` reports coverage over the non-instrumental denominator plus a `lyricsFunnel`; coverage keys on `lyrics IS NOT NULL` so tracks enriched before the field existed still count.
  - **Match confidence (#248).** Before a candidate's lyrics are stored, `enrichLyrics` scores the match with `scoreLyricsMatch` (`src/enrichment/match-confidence.ts`, the shared Sørensen–Dice title/artist similarity + duration tolerance also used by the MusicBrainz matcher): `confidence = min(titleSim, artistSim) × (duration disagrees ? 0.5 : 1)`, where an absent axis or unknown duration scores 1.0 (absence is not evidence against — this keeps Genius, which never carries a duration, viable). A match at or above `LYRICS_CONFIDENCE_THRESHOLD` (env, default **0.85**, fails safe to the default on garbage/out-of-range) is stored `resolved` with `lyricsConfidence` + `lyricsMatchedTitle`/`lyricsMatchedArtist` provenance; below it is stamped `low-confidence` (the lyric **text is dropped**, `lyrics` stays NULL so honest coverage and the fulltext index stay clean) with the score + provenance recorded so the doubt is visible and auditable. This is the gate that prevents the #31 wrong-song corruption class (artist matched, wrong song) and the live/remix-with-different-lyrics class (duration mismatch). The `GeniusClient` additionally pre-filters obvious title mismatches before the page scrape (a strict subset of this gate). `low-confidence` is **non-terminal** — a better catalog match or a retuned threshold can upgrade it later — and stays in the honest coverage denominator. Cross-source LRCLIB↔Genius agreement (the issue's signal #3) is a deliberate follow-up: the short-circuit flow never fetches both for one track.
  - Full rationale in [`docs/adr/0001-lyrics-resolution-strategy.md`](../../docs/adr/0001-lyrics-resolution-strategy.md).
- **Enrichment markers are `*FetchedAt` timestamps, not booleans (issue #89).** Every external-source enrichment stamps `<source>FetchedAt = datetime()` after each attempt. The candidate query selects a node only when it **still lacks the data** (e.g. `recordingMbid IS NULL`, `NOT EXISTS { (a)-[:ORIGIN_COUNTRY]->() }`, `lyrics IS NULL`) **and** its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30). So a node a source had no data for is retried at most once per window — picking up newly-added coverage or a fixed client without a full re-ingest — while already-enriched nodes are never re-fetched automatically. Transient errors don't stamp (they retry next run); the `/admin/<x>/reset` routes still force a full re-fetch. The marker is set server-side via `datetime()`, so there is no client-clock dependency. Helper: `src/enrichment/staleness.ts`. This `*FetchedAt` throttle is the **throttled-recheck** half of the two-state model; the **terminal-empty** half (a permanent marker so a never-fillable absence — instrumental, confirmed non-group — is excluded for good, counted `exhausted` not `skipped`) is the `TERMINAL_EMPTY` runner outcome (#367, [ADR 0003](../../docs/adr/0003-enrichment-terminal-vs-throttle.md)). Terminal is opt-in per source; today `lyrics` (`lyricsStatus` enum) and `group-members` (`notAGroup`) use it, the rest are throttle-only.
- **No time signature from AcousticBrainz.** AcousticBrainz low-level rhythm descriptors do not expose a reliable categorical time signature. The `t.tempo` / `t.musicalKey` / `t.musicalScale` fields are trustworthy; a `time_signature` integer equivalent to Spotify's is not available without self-hosted Essentia analysis on the actual audio files.
- **AcousticBrainz audio features are estimates, not Spotify values.** `danceabilityEstimate` and `voiceInstrumental` are AcousticBrainz high-level classifier outputs — a different model trained on different data from Echo Nest/Spotify. They are labelled `...Estimate` deliberately and must never be presented as equivalent to Spotify features.
- **Deezer is an independent, ISRC-keyed audio-feature source.** `deezerBpm` and `deezerGain` (a loudness figure) are stored under `deezer*` property names rather than overwriting `tempo`/`loudnessDb`, so the source stays traceable and the two BPM figures can be compared. Deezer is an admin-route enrichment (not part of `runIngestion`) that depends on `isrc` being populated first by `track-musicbrainz` enrichment. Deezer returns `0` for unknown values — these are coerced to null before storing. `deezerGain` is a ReplayGain-style loudness figure; it is not the same metric as `loudnessDb`.
- **`formats[].qty` is a string in the API.** The Discogs API returns `qty` as a string (e.g. `"1"`), not a number. Always `parseInt` before storing. Do not assume it is numeric.
- **Track `duration` is frequently empty string.** The API returns `""` for tracks without listed duration. Treat `""` as null — do not store the empty string.
- **`basic_information` in collection responses is incomplete.** The collection endpoint's `basic_information` object omits `country`, `extraartists`, and other fields. Always fetch the full release via `GET /releases/{id}` before ingesting.
- **The stats-snapshot timer doubles as the Aura keep-warm (issue #103).** `startStatsSnapshots` (`src/observability/stats-snapshot.ts`) runs real Cypher (`getStats`) on pod startup and every 6h, which is what holds AuraDB Free open — a connectivity check does not reset its 72h auto-pause timer, a real query does. `MAX_SNAPSHOT_INTERVAL_MS` is capped below `AURA_PAUSE_WINDOW_MS` (72h) with a guarding unit test so the interval can't be configured out of the window. Keep-warm rides the pod, so it only runs while the k3s node is up; a long `power:off` intentionally lets Aura pause (manual resume — see infra/RUNBOOK.md "Keeping Aura warm").
- **`CREDITED_ON` deduplication on re-run.** Because MERGE on a relationship between two nodes does not have a separate key — it matches by the full (from, type, to) pattern — re-running ingest updates relationship properties in-place. This is correct and intentional.
- **Rate limiter keys on `cf-connecting-ip` only when `TRUST_CF_CONNECTING_IP=true` (issue #287).** Behind Cloudflare the direct peer (`request.ip`) is a shared CF-edge/NodePort-SNAT address, so all public traffic would otherwise collapse into one bucket. The flag is off by default (local dev / forks key on the real peer) and is **only safe with the CF-only SG lockdown** (`restrict_app_to_cloudflare`) in front — otherwise the header is spoofable. Authenticated admin calls are exempt from the limiter (`allowList` → `isAuthorizedAdmin`) so a public flood can't 429 the operator out; a wrong/absent token is still limited. See `buildRateLimitOptions` in `src/server.ts`.
