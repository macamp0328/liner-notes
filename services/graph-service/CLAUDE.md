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

> **Authoritative model lives in [`docs/schema/SCHEMA.md`](docs/schema/SCHEMA.md).** The exact
> labels/properties/relationships/constraints of the **running graph** are auto-generated from a live
> introspection by `pnpm schema:diagram` (ADR 0004) — an ER + graph-of-labels diagram that render on
> GitHub, plus a machine-readable `docs/schema/schema-snapshot.json`, with
> [`docs/schema/schema-drift.md`](docs/schema/schema-drift.md) flagging any divergence from
> `src/db/schema.ts`. The tables below are **hand-written commentary** — they add provenance the
> generator can't (enrichment sourcing, nullability, `#issue` refs) but **drift on exact
> properties**; trust the generated artifacts for the current shape.

> **Why the keys are what they are** — the Discogs `discogsId` spine, ISO-3166-keyed `Country` (+ a
> separate `:Region` concept), MBID/ISRC/QID as crosswalk attributes rather than spine keys, and the
> "one canonical write path per multi-writer entity" + uniform edge-`source` enforcement laws — is
> recorded in [ADR 0005](../../docs/adr/0005-entity-identity-and-write-paths.md).

### Nodes

| Label         | Key Properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Release`     | `discogsId` (unique), `title`, `pressingYear` (integer), `originalYear` (integer, nullable), `format`, `thumbUrl`, `masterDiscogsId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Artist`      | `discogsId` (unique), `name`, `realName`, `profile`, `genres[]`, `styles[]` (last two aggregated onto the Artist by the `artist-genres` enrichment); `musicbrainzId` (nullable) + `musicbrainzIdFetchedAt` (datetime) — the MB-artist MBID resolved by the `mb-artist-id` pass (#380), the deterministic Discogs↔MB join key for `WROTE`; plus Wikidata-sourced (#341/#393, set by `artist-wikidata`): `wikidataQid`, `bornYear`/`bornDate`, `diedYear`/`diedDate` (date string only at day precision), `imageUrl`, `awards[]`, `playsInstrument[]` (P1303 instruments normalized onto the #333 family vocab) + `playsInstrumentRaw[]` (the raw English labels), `influencedByQids[]` (P737 "influenced by" target QIDs, #391 — the raw list the `artist-influences` pass resolves into `INFLUENCED_BY` edges), `memberOfQids[]` + index-aligned `memberOfSinceYears[]` / `memberOfUntilYears[]` (P463 "member of" group QIDs + P580/P582 begin/end years, `0` = unknown, #392 — the raw arrays the `band-membership` pass resolves into dated `MEMBER_OF {source:"wikidata"}` edges), `wikidataFetchedAt`                                                                                                    |
| `Label`       | `discogsId` (unique), `name`, `profile`, `contactInfo`, `labelHierarchyFetchedAt` (datetime — set by the label-hierarchy enrichment, #332)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Track`       | `position` + `releaseDiscogsId` (composite MERGE key), `title`, `duration`, `durationSeconds` (integer, nullable), `lyrics` (nullable), `lyricsSource`, `lyricsStatus` (`resolved`/`instrumental`/`probable-instrumental`/`low-confidence`/`not-found`, nullable), `lyricsConfidence` (float 0–1, nullable), `lyricsMatchedTitle` (nullable), `lyricsMatchedArtist` (nullable), `lyricsFetchedAt` (datetime), `recordingMbid` (nullable), `isrc` (nullable), `musicBrainzFetchedAt` (datetime), `worksFetchedAt` (datetime — set by the track-works enrichment, #336), `recordingArtistsFetchedAt` (datetime — set by the track-recording-artists enrichment, #335), `recordingPlacesFetchedAt` (datetime — set by the track-recording-places enrichment, #339 slice 2), `tempo` (nullable), `musicalKey` (nullable), `musicalScale` (nullable), `loudnessDb` (nullable), `dynamicComplexity` (nullable), `danceabilityEstimate` (nullable), `voiceInstrumental` (nullable), `acousticBrainzFetchedAt` (datetime), `acousticBrainzExhausted` (boolean, nullable — terminal marker for a frozen-source confirmed absence, #384), `deezerBpm` (nullable), `deezerGain` (nullable), `deezerFetchedAt` (datetime) |
| `Genre`       | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Style`       | `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Country`     | `name` (unique) — **ISO 3166-1 alpha-2** (#441/ADR 0005): every writer normalizes via `normalizeCountry` so MB/Wikidata codes + Discogs names collapse onto one node (`UK`→`GB`); defunct states with no current ISO code (`Yugoslavia`, `Czechoslovakia`, `USSR`, GDR, `Netherlands Antilles`, `Rhodesia`) deliberately stay readable name-keyed nodes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Region`      | `name` (unique) — the non-country market vocabulary split off so `:Country` stays pure ISO (#441): short codes `EU`/`WW` + readable markets (`Scandinavia`, `Benelux`, `Asia`, `Australasia`, `South East Asia`, `Middle East`, `CIS`, `Gulf Cooperation Council`, `North America`). From `normalizeCountry(...).regions`; a compound market (`UK & Europe`) writes a Country edge to `GB` **and** a Region edge to `EU`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Studio`      | `nameKey` (UNIQUE merge key = `toLower(trim(name))`, #443) + `name` (human display, preserved verbatim via `ON CREATE SET`); plus MusicBrainz Place location data (#339 slice 2, nullable, set by `track-recording-places`): `latitude`/`longitude` (decimal degrees), `area` (city/region label), `musicbrainzPlaceId` (provenance). Both writers MERGE on `nameKey` so case/space variants collapse onto one node                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Musician`    | `discogsId` (if available), `name`, `musicbrainzId` (nullable) + `musicbrainzIdFetchedAt` (datetime — #380, same MB-artist join key as Artist) — the generic "credited person" node. Every credited contributor (performers, producers, engineers, …) is a `Musician`; the specific role lives on the `CREDITED_ON` edge (`roleCategory` / `displayRole`), not on a distinct node label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Master`      | `discogsId` (unique), `title`, `year`, `mbReleaseEventsFetchedAt` (datetime) — the canonical album grouping a `Release` is a pressing of. Holds the original-year + global pressing-country/format facts (see `RELEASED_IN` / `MB_RELEASED_IN`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Work`        | `mbid` (unique), `title`, `type` (MusicBrainz work type, e.g. `Song`), `writers` / `writerMbids` / `writerRoles` (index-aligned provenance arrays, `source: musicbrainz`, #336) — the **composition** (song as written), keyed on the MusicBrainz work MBID. A `Track` links to it via `RECORDING_OF`; two Tracks `RECORDING_OF` the same Work but different recordings are versions/covers. The captured `writerMbids` are promoted to `(:Artist`/`:Musician)-[:WROTE]->(:Work)` edges by the `songwriter-reconciliation` pass (#380).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ReloadJob`   | `jobId` (unique), `status`, `startedAt`, `completedAt`, `durationMs` — one node per orchestrated reload run (#175), the checkpoint root. `finishReloadJob` prunes terminal (`complete`/`failed`) jobs beyond the newest `RELOAD_JOB_HISTORY_KEEP` (default 10) + their stages, so they don't accumulate; a `running`/resumable job is never pruned (#355).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ReloadStage` | `jobId` (indexed, **not** unique), `stage`, `ordinal`, `status`, `counts` (JSON, numeric except the `releases` stage's bounded `failedReleaseIds` array — the lone non-numeric count, #417), `error` — one per stage per job; linked from its `ReloadJob` by `HAS_STAGE`. Survives a pod restart so a killed reload resumes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

> `pressingYear` is the year this specific pressing was manufactured (from Discogs `release.year`). `originalYear` is the year the album was first released anywhere, fetched from the Discogs master release endpoint and stored as a post-ingestion enrichment step. Queries that order or filter by release date should prefer `coalesce(r.originalYear, r.pressingYear)`.

### Relationships

| Relationship            | From → To                    | Properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RELEASED_BY`           | Release → Artist             | `role`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CREDITED_ON`           | Musician → Release or Track  | `role`, `displayRole`, `roleCategory` (`"performer"`/`"producer"`/`"engineer"`/…), `instrument` (normalized instrument family derived from `role`; `null` for non-instrument roles), `creditedAs`, `scope` (`"release"` or `"track"`), `source` (`"discogs"` on Discogs-ingest credits; `"musicbrainz"` on MB-sourced track credits, #335/#442); MB track credits also carry `recordingMbid` (provenance)                                                                                        |
| `ON_LABEL`              | Release → Label              | `catalogNumber`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PARENT_LABEL`          | Label → Label                | child → parent; the Discogs label hierarchy (#332). Populated by the label-hierarchy enrichment from `parent_label` (sublabels[] not ingested)                                                                                                                                                                                                                                                                                                                                                   |
| `IN_GENRE`              | Release → Genre              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IN_STYLE`              | Release → Style              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FROM_COUNTRY`          | Release → Country            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RECORDED_AT`           | Release → Studio             | `source` (`"discogs"`, #442) — album-level studio from Discogs `companies[]`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RECORDED_AT`           | Track → Studio               | `source` (`"musicbrainz"`), `recordingMbid`, `relation` (`"recorded at"` / `"mixed at"`) — track-level studio from MusicBrainz recording `place-rels` (#339 slice 2). Written by the `track-recording-places` pass, MERGEing the Studio by the canonical `nameKey` (#443) onto the Discogs-keyed nodes. Sparse by design. Surfaced through `GET /explore/studio/:name` (track edges roll up to the Release via `HAS_TRACK`).                                                                     |
| `HAS_TRACK`             | Release → Track              | `trackNumber`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RECORDING_OF`          | Track → Work                 | `source` (`"musicbrainz"`) — the Track is a recording of this composition (#336), from MB recording→work relationships joined on `recordingMbid` by the `track-works` enrichment. Backs `GET /explore/work/:mbid`.                                                                                                                                                                                                                                                                               |
| `SAME_PERSON_AS`        | Musician → Artist            | by shared `discogsId` — written inline on ingest AND by the standalone `person-reconciliation` pass (#330, backfills late-Artist links)                                                                                                                                                                                                                                                                                                                                                          |
| `WROTE`                 | Artist or Musician → Work    | `source` (`"musicbrainz"`), `roles` (e.g. `["composer", "lyricist"]`) — the person wrote this composition (#380), from each Work's captured `writerMbids` joined to a person's `musicbrainzId` by the `songwriter-reconciliation` pass (MBID join only, never name-matching). Backs `GET /explore/songwriter/:name`.                                                                                                                                                                             |
| `MEMBER_OF`             | Musician → Musician          | `active` (Boolean), `source` (`"discogs"`, #442) — group membership from Discogs `/artists/{id}` `members[]`, written by the `group-members` pass (#330)                                                                                                                                                                                                                                                                                                                                         |
| `MEMBER_OF`             | Artist → Artist              | `source` (`"wikidata"`), `since` / `until` (begin/end **year**, absent when unknown) — dated band membership from Wikidata P463 + P580/P582 (#392). Written by the `band-membership` pass, which resolves each captured `memberOfQids` group against another Artist's `wikidataQid` (deterministic QID join; unowned groups dropped). **Distinct from and additive to** the Discogs Musician→Musician variant above — both survive with provenance ("keep both"). Sparse by design.              |
| `ORIGIN_COUNTRY`        | Artist or Musician → Country | `source` (`"musicbrainz"` / `"wikidata"`; absent on edges written before the prop existed → surfaces as `untagged` in `/stats`)                                                                                                                                                                                                                                                                                                                                                                  |
| `INFLUENCED_BY`         | Artist → Artist              | `source` (`"wikidata"`) — the source artist was influenced by the target, from Wikidata P737 (#391). Written by the `artist-influences` pass, which resolves each captured `influencedByQids` target against another Artist's `wikidataQid` (deterministic QID join; unowned targets dropped). Sparse by design — "influence within my collection." Backs `GET /explore/influences/:name`.                                                                                                       |
| `RELEASED_IN`           | Master → Country             | `formats` — global pressing countries/formats from the Discogs master-data enrichment                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MB_RELEASED_IN`        | Master → Country             | `mbReleaseId` (merge key), `date`, `formats`, `formatFamilies` (normalized physical-medium vocab `vinyl`/`cassette`/`cd`/`8-track`/`reel`/`other`, derived from `formats`, #458), `source` (`"musicbrainz"`, #442) — release events from the MusicBrainz enrichment. **Physical-pressing reach by construction (#458):** digital-only release-events (`Digital Media`) are dropped, so a worldwide digital edition's per-country storefront list no longer saturates the distinct-country count. |
| `FROM_REGION`           | Release → Region             | #441 — Region counterpart of `FROM_COUNTRY` (Discogs market token, e.g. `Europe`/`Worldwide`). Structural, no `source`.                                                                                                                                                                                                                                                                                                                                                                          |
| `RELEASED_IN_REGION`    | Master → Region              | `formats` — #441 Region counterpart of `RELEASED_IN` (Discogs master-data regional-market pressings).                                                                                                                                                                                                                                                                                                                                                                                            |
| `MB_RELEASED_IN_REGION` | Master → Region              | `mbReleaseId` (merge key), `date`, `formats`, `formatFamilies` (#458, same physical-medium vocab as `MB_RELEASED_IN`), `source` (`"musicbrainz"`) — #441 Region counterpart of `MB_RELEASED_IN` (MB `XE`/`XW` Europe/Worldwide events). Digital-only events dropped the same way (#458).                                                                                                                                                                                                         |
| `HAS_STAGE`             | ReloadJob → ReloadStage      | `ordinal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
CREATE CONSTRAINT region_name        IF NOT EXISTS FOR (g:Region)  REQUIRE g.name IS UNIQUE;
-- #443: Studio is keyed on a folded nameKey (toLower(trim(name))), NOT name — case/space variants
-- collapse onto one node while the display `name` stays readable. (See mergeStudioClause.)
CREATE CONSTRAINT studio_name_key    IF NOT EXISTS FOR (s:Studio)  REQUIRE s.nameKey IS UNIQUE;
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

All `/explore/*` routes return a **bare JSON array** — _not_ a `{ data }` envelope — except five:
`/explore/connections/:discogsId` returns `{ seed, nodes }`, `/explore/instrument/:name` returns
`{ credits, players }` (the two instrument axes, #393), `/explore/influences/:name` returns
`{ influencedBy, influenced }` (the two influence directions, #391), `/explore/membership/:name`
returns `{ bands, bandmates }` (the Wikidata P463 band neighbourhood, #424), and `/explore/path`
returns `{ from, to, found, length, maxDepth, steps }` (the shortest human/credit path, #343).

> **Edge-specificity weighting (#331).** `/connections` and `/related` weight a shared neighbour by
> `1/degree` (`COUNT { (n)--() }`) so a niche `Studio` (degree ~2 → 0.5) outranks a `Genre:Rock` hub
> (degree ~150 → 0.007). It is **plain Cypher computed in-query** — no GDS (unavailable on Aura Free),
> no precomputed-degree property, no refresh job (self-maintaining). `/related` is the curated,
> hub-suppressed _relatedness ranking_: it reuses `getPath`'s `PATH_RELATIONSHIPS` allowlist
> (`CREDITED_ON`/`RECORDED_AT`/`SAME_PERSON_AS`/`MEMBER_OF`) so genre/country/label/track hubs and the
> same-headline-artist `RELEASED_BY` edge are excluded **by construction** (allowlist is the primary
> hub filter; `1/degree` is the refinement over the already-clean set). `/connections` stays the broad
> _reachability_ view, now annotated with each node's own `degree`/`weight` and ordered specific-first.

| Method | Path                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/explore/musician/:name`            | Releases featuring this musician                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`  | `/api/v1/explore/producer/:name`            | Releases this person produced                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET`  | `/api/v1/explore/engineer/:name`            | Releases this person engineered                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET`  | `/api/v1/explore/instrument/:name`          | Who plays this normalized instrument (e.g. `bass`) — returns `{ credits, players }` (#393): `credits` = per-credit musicians + releases (release-scoped), `players` = artists Wikidata P1303 documents as playing it                                                                                                                                                                                                    |
| `GET`  | `/api/v1/explore/work/:mbid`                | Every recording of this MusicBrainz Work in the collection — "every version of this song I own" (#336); distinct `recordingMbid`s = versions/covers                                                                                                                                                                                                                                                                     |
| `GET`  | `/api/v1/explore/songwriter/:name`          | Every composition this person wrote and its recordings in the collection — "everything written by X" (#380), via `WROTE` edges across both Artist and Musician                                                                                                                                                                                                                                                          |
| `GET`  | `/api/v1/explore/influences/:name`          | The two-directional Wikidata P737 influence neighbourhood — returns `{ influencedBy, influenced }` (#391): who influenced this artist and who they influenced, restricted to in-collection artists (sparse by design)                                                                                                                                                                                                   |
| `GET`  | `/api/v1/explore/membership/:name`          | The Wikidata P463 band-membership neighbourhood — returns `{ bands, bandmates }` (#424): the bands this artist belonged to (each with `since`/`until` tenure years, null when unknown) and the other in-collection members of those bands, restricted to in-collection artists (sparse by design)                                                                                                                       |
| `GET`  | `/api/v1/explore/studio/:name`              | Releases recorded at this studio                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`  | `/api/v1/explore/recording-locations`       | Recording-location map data (#342): every Studio with known MusicBrainz Place coordinates (#339 slice 2), each with `latitude`/`longitude`/`area` + per-studio `releaseCount`/`trackCount` for marker sizing; unplaced studios omitted. Ordered by `releaseCount` desc                                                                                                                                                  |
| `GET`  | `/api/v1/explore/decade/:decade`            | Releases from this decade (accepts `1970s`)                                                                                                                                                                                                                                                                                                                                                                             |
| `GET`  | `/api/v1/explore/year/:year`                | Releases from this exact year                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET`  | `/api/v1/explore/label/:name`               | Releases on this label (`?includeSublabels=true` rolls up the whole PARENT_LABEL family, #332)                                                                                                                                                                                                                                                                                                                          |
| `GET`  | `/api/v1/explore/genre/:name`               | Releases in this genre                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET`  | `/api/v1/explore/style/:name`               | Releases in this style                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET`  | `/api/v1/explore/country/:name`             | Releases from this country                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET`  | `/api/v1/explore/connections/:discogsId`    | Graph traversal (`?depth=N`, max 3) — returns `{ seed, nodes }`; each node is tagged with its `degree` + edge-specificity `weight` (1/degree) and the list is ordered most-specific-first so the 200-cap keeps the rarest connections (#331)                                                                                                                                                                            |
| `GET`  | `/api/v1/explore/related/:discogsId`        | Releases most related to this one, ranked by edge specificity (#331): `Σ 1/degree` over shared bridges traversing only the `CREDITED_ON`/`RECORDED_AT`/`SAME_PERSON_AS`/`MEMBER_OF` allowlist (genre/country/label hubs + same-headline-artist excluded by construction). Bare array of `ExploreRelease` + `score` + `bridges[]` ({type,name,weight}); `?limit=N` (1–100, default 25); 404 if unknown, `[]` if isolated |
| `GET`  | `/api/v1/explore/path?from=&to=`            | "Six degrees" finder (#343): shortest human/credit path between two endpoints over the `CREDITED_ON`/`RECORDED_AT`/`SAME_PERSON_AS`/`MEMBER_OF` allowlist (hubs excluded by construction). `from`/`to` are numeric (Release `discogsId`) or a name (Musician/Artist), mixable; `?maxDepth=N` (1–6, default 6). Returns `{ from, to, found, length, maxDepth, steps }`                                                   |
| `GET`  | `/api/v1/explore/shared-musicians`          | Release pairs sharing session musicians                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET`  | `/api/v1/explore/tracks/most-international` | Tracks whose credited musicians span the most countries of origin (needs nationality enrichment)                                                                                                                                                                                                                                                                                                                        |
| `GET`  | `/api/v1/explore/releases/most-pressed`     | Releases with the widest global pressing reach (needs master-data enrichment)                                                                                                                                                                                                                                                                                                                                           |
| `GET`  | `/api/v1/explore/tracks/by-audio-features`  | Filter Tracks by audio features (tempo, key, scale, danceability, vocal/instrumental)                                                                                                                                                                                                                                                                                                                                   |

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
**20** pipelines — `lyrics`, `nationality`, `master-data`, `mb-release-events`, `track-musicbrainz`,
`track-works` (#336, writes `RECORDING_OF` to MBID-keyed `Work` nodes from MB recording→work rels),
`track-recording-artists` (#335/#339, pushes MB recording performance, production
(producer/engineer) **and** arranging (arranger family, `composer`-bucketed) credits down to
track-scoped `CREDITED_ON` edges, resolving each person by the `musicbrainzId` join),
`track-recording-places` (#339 slice 2, writes track-scoped `(:Track)-[:RECORDED_AT {source:"musicbrainz"}]->(:Studio)`
from MB recording `place-rels`, MERGEing the Studio by `name` + capturing Place coordinates/area),
`track-acousticbrainz`, `track-deezer`, `artist-profiles`, `artist-genres`, `artist-wikidata` (#341/#393,
resolves each Artist's `wikidataQid` via P1953/Wikipedia-URL and writes lifespan/image/awards plus the
person-level P1303 instruments — `playsInstrument`/`playsInstrumentRaw` — in the same bundle),
`label-hierarchy` (#332, writes `PARENT_LABEL` from a per-Label `/labels/{id}` fetch), `group-members`
(#330, writes `MEMBER_OF` from a per-Musician `/artists/{id}` sweep), `person-reconciliation` (#330,
backfills `SAME_PERSON_AS`), `mb-artist-id` (#380, resolves each Artist/Musician's MB-artist MBID into
`musicbrainzId` via the Discogs-URL relation), `songwriter-reconciliation` (#380, promotes captured
Work `writerMbids` to `WROTE` edges by the `musicbrainzId` join), `artist-influences` (#391, projects
each Artist's captured `influencedByQids` into `INFLUENCED_BY` edges by the `wikidataQid` join — pure
Cypher, no new Wikidata calls), `band-membership` (#392, projects each Artist's captured `memberOfQids`

- begin/end years into dated `MEMBER_OF {source:"wikidata", since, until}` edges by the `wikidataQid`
  join — pure Cypher, no new Wikidata calls) — and for each:

* `POST /api/v1/admin/<stage>/enrich` — run that stage standalone (returns `202`; poll status). Four
  also run inside `runIngestion`; the rest are manual-only (see Ingestion Pipeline below).
* `GET /api/v1/admin/<stage>/status` — that stage's last-run counts / running flag.
* `POST /api/v1/admin/<stage>/reset` — force a full re-fetch. **Exists for 13 stages only** — the
  seven _without_ a `reset` route are `lyrics` (use `/api/v1/admin/lyrics/clear-genius` instead),
  `master-data`, `artist-genres` (a self-idempotent whole-graph aggregation with nothing to reset),
  `person-reconciliation`, `songwriter-reconciliation`, `artist-influences`, and `band-membership`
  (these four reconciliation/projection passes re-link exhaustively every run — nothing to reset;
  `artist-wikidata`'s reset clears the upstream `influencedByQids` + `memberOf*` arrays).
  `label-hierarchy` and `group-members` both _have_ a reset (label-hierarchy
  clears `labelHierarchyFetchedAt` + deletes PARENT_LABEL edges; group-members deletes every
  `MEMBER_OF` edge + clears `membersFetchedAt`); `mb-artist-id` has one too (clears `musicbrainzId` +
  `musicbrainzIdFetchedAt`); and `artist-wikidata`'s reset clears `wikidataFetchedAt` + every
  Wikidata-sourced property.

### Response Shapes

Envelope cheat-sheet — read this before writing a client:

| Endpoint(s)                                             | Success shape                                  |
| ------------------------------------------------------- | ---------------------------------------------- |
| `releases`, `releases/:id`, `artists/:id`, `labels/:id` | `{ data, pagination? }`                        |
| `stats`                                                 | `{ data }`                                     |
| `explore/*` (except the five below)                     | **bare array**                                 |
| `explore/instrument/:name`                              | `{ credits, players }`                         |
| `explore/influences/:name`                              | `{ influencedBy, influenced }`                 |
| `explore/membership/:name`                              | `{ bands, bandmates }`                         |
| `explore/connections/:discogsId`                        | `{ seed, nodes }`                              |
| `explore/path`                                          | `{ from, to, found, length, maxDepth, steps }` |
| `search`, `search/lyrics`                               | **bare array**                                 |

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
  siblings. A stage may additionally opt into a **bounded in-stage retry sweep** (#455) by passing
  `retry` to `runEnrichment`: after the main pass, failures its `isRetryable` predicate accepts are
  re-`resolve`d for up to `maxRounds` rounds with an escalating jittered backoff, so a transient blip
  recovers _within the same run_ instead of leaving a durable gap until the next staleness window
  (the gap a fresh reload has no later window to close). **Only `lyrics` opts in today**
  (`LYRICS_RETRY_ROUNDS`, default 2). The sweep is skipped on SIGTERM and when transient failures
  exceed an outage cap (`max(25, maxRetryableFraction × candidates)` — an absolute floor so a small
  collection always sweeps, a fraction so a large reload skips a clear outage); `failed` reflects
  post-sweep reality and the new `recovered` count reports how many it reclaimed (surfaced in
  `/admin/reload/status`).

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
arrival order. The #455 retry sweep reuses this same bounded pool, but calls the inner `processItem`
directly (never the main-pass `handleItem`), so it does **not** re-report progress, advance
`completed`, or re-collect retryable failures — it only re-runs the resolve/write contract and
reclassifies the outcome. **Only `lyrics` opts in today** (`LYRICS_CONCURRENCY`, default 6, clamped
`[1, 12]`), and only because it is deadlock-immune — it writes one Track per transaction, so it
carries no resource lane (see "Scheduling (#176)"). Bounded concurrency IS the lyrics stage's rate ceiling
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

8. **`instrument` is a derived, separate `CREDITED_ON` property (#333).** `parseInstrument(role)` in `transforms.ts` normalizes the free-text Discogs role onto a controlled 25-family vocabulary (`bass`, `guitar`, …) so credit queries don't enumerate every spelling. The raw `role` and first-token `displayRole` are kept verbatim for provenance — `instrument` never overwrites them. It is **not** gated on `roleCategory === 'performer'`: the role-category performer keyword list is narrower than the instrument vocabulary, so gating would silently null real instruments (`Trombone`, `Viola`, `Clarinet`, `Vibraphone` all bucket as `roleCategory: 'other'`). Non-instrument roles (producers, engineers, visual, crew) store `instrument = null`. `INSTRUMENT_RULES` is priority-ordered and the order is load-bearing (drums/clarinet before bass, vibraphone before percussion, bowed before strings, harmonica before harp) — see the comment on the table. Backs `GET /api/v1/explore/instrument/:name`. **Person-level axis (#393):** the same family vocabulary also feeds `Artist.playsInstrument[]` — instruments-a-person-plays from Wikidata P1303, normalized via the shared `normalizeInstrumentFamilies` (raw labels kept in `playsInstrumentRaw[]`). This is a **separate axis** from the per-credit `CREDITED_ON.instrument` (what someone played on a given track/release): same vocabulary, distinct locations, so a `bass` query lines up across both. `/explore/instrument/:name` returns both as `{ credits, players }`.

9. **`Work` cover/version model is MBID-keyed; writers are promoted to `WROTE` edges via a deterministic identity join (#336, #380).** `(:Work {mbid})` + `(:Track)-[:RECORDING_OF]->(:Work)` are populated **only** from MusicBrainz recording→work relationships joined on the `recordingMbid` we already store — never title/fuzzy matching (the #185/#250 lesson: title matching only ever finds same-recording duplicates). Covers/versions are a derived query (`GET /explore/work/:mbid`), not a stored heuristic — two Tracks `RECORDING_OF` the same Work but different recordings are versions; the same recording reissued is a duplicate. Composer/lyricist/writer credits are fetched (`/work/{mbid}?inc=artist-rels`) and stored as **provenance arrays on the Work** (`writers`/`writerMbids`/`writerRoles`), keyed by MB-artist MBID. #380 promotes them to real `(:Artist`/`:Musician)-[:WROTE]->(:Work)` edges **deterministically**: a dedicated `mb-artist-id` pass first resolves each person's MB-artist MBID into `musicbrainzId` (via the Discogs-URL relation — the same lookup nationality already makes, so it reuses it for **zero net new MB calls**), then the `songwriter-reconciliation` pass joins `writerMbids` → `musicbrainzId` and MERGEs the `WROTE` edge (with `roles`). **Still an MBID join only, never name-matching** (forbidden). Both labels carry `WROTE` so a songwriter that exists only as a primary `Artist` node still links. Coverage is `/stats.worksWithWriterLinks` (verify-gated for silently-zero) + the raw `wroteEdges` count; the query is `GET /explore/songwriter/:name`.

10. **MB recording performance, production AND arranging credits are pushed down to track-scoped `CREDITED_ON` by a deterministic MBID join (#335, #339).** The `track-recording-artists` enrichment fetches `/recording/{mbid}?inc=artist-rels` for each `recordingMbid` and writes the **performance** relations (`performer`/`instrument`/`vocal`), the recording-level **production** relations (#339 — `producer` plus the engineer family: `engineer`/`recording`/`mix`/`audio`/`sound`/`balance`, mapped in the client to a canonical role string like `recording engineer` so `parseRoleCategory` buckets them `producer`/`engineer`), and the recording-level **arranging** relations (#339 — `arranger`/`instrument arranger`/`vocal arranger`/`orchestrator`, mapped so `parseRoleCategory` buckets them `composer` — the `orchestrat` keyword covers `orchestrator`) as `(:Musician)-[:CREDITED_ON {scope:"track", source:"musicbrainz", recordingMbid}]->(:Track)`. MusicBrainz models producer/engineer/arranger at the **recording** level, so unlike Discogs's album-level production credits they are genuinely track-attributable. Inherently whole-release roles (`mastering`/lacquer/cover-art) stay release-scoped and are **never** pushed down; `remixer` (the recording-lineage epic) is also excluded by the client, as are the production/arranging _qualifier_ attributes (`additional`/`co`/`executive`/…), which are dropped so the credit token is the canonical role, not `co`. Each person is resolved by `MERGE (m:Musician {musicbrainzId})` — the same MB-artist MBID the `mb-artist-id` pass (#380) already stored — so the stage **deps `mb-artist-id`** (running it first lets a person whose Discogs↔MB link resolved be reused instead of duplicated). A person that **cannot** be resolved this way — one MusicBrainz has no Discogs link for, so no in-collection node carries that MBID — gets an **MBID-keyed fallback `Musician`** (`musicbrainzId` set, no `discogsId`) linked to any same-MBID `Artist` via `SAME_PERSON_AS`, never merged by name. That fallback can still be a second node for a person who also exists only as a `discogsId`-keyed `Musician` without a `musicbrainzId`; this is the deliberate clean-data tradeoff (provenance preserved over a fuzzy name-merge), not a bug. A person who both performs _and_ produces a track gets one combined `CREDITED_ON` edge (one per person/track), whose single `roleCategory` follows the parse precedence (`performer` wins) — producer/arranger-ness stays in the `role` string. The credit props use `ON CREATE SET`, so an existing Discogs credit for the same person/track is **never clobbered** — MB only fills gaps. Reuses `parseDisplayRole`/`parseRoleCategory`/`parseInstrument` so performance credits stay queryable via `/explore/instrument/:name` and production credits via `/explore/producer|engineer/:name` (which roll track-scoped credits up to the Release via `HAS_TRACK`, #339). Arranging credits bucket `composer` (shared with Discogs `arranged by`/`written-by`), so they surface via `/explore/musician/:name` and the composer axis rather than a dedicated arranger route (a precise `/explore/arranger` would need a role-text match — deferred). Coverage is `/stats.tracksWithMbRecordingArtists` (verify-gated for silently-zero, denominator = tracks with a `recordingMbid`) plus `/stats.tracksWithMbProductionCredits` (the producer/engineer subset) and `/stats.tracksWithMbArrangers` (the composer-bucket arranger subset) — both measured but **un**gated, since recording-level production/arranging can legitimately be near-zero; `/track-recording-artists/reset` deletes the MB credits + the fallback nodes.

11. **MB recording-level studios are pushed down to track-scoped `RECORDED_AT` from `place-rels` (#339 slice 2).** The `track-recording-places` enrichment fetches `/recording/{mbid}?inc=place-rels` for each `recordingMbid` and writes `(:Track)-[:RECORDED_AT {source:"musicbrainz", recordingMbid, relation}]->(:Studio)` for every `recorded at` / `mixed at` Place — a deterministic per-track studio source Discogs (album-level `companies[]` only) cannot give. The Studio is `MERGE`d by **`name`** onto the existing Discogs-keyed nodes (Discogs carries no Place MBID, so name is the only shared join key, and the value is that a track's MB studio _lines up_ with the album's Discogs studio of the same name); the Place MBID is kept as a `musicbrainzPlaceId` **property** for provenance, never the merge key. The Place's `coordinates`/`area` enrich the Studio via `coalesce` (only ever fill a gap — a later null-coord fetch never clobbers good coords), feeding the recording-location map (#342). Both `recorded at` and `mixed at` map to one `RECORDED_AT` edge (mirroring the Discogs path, which collapses `entity_type` 23+27), the MB type kept on `relation`. Stamps `recordingPlacesFetchedAt` on every candidate Track (throttled-recheck, #89). Coverage is `/stats.tracksWithMbStudio` (denominator = tracks with a `recordingMbid`), **measured but intentionally un-gated** — MB place relations are even sparser than production credits and this stage has its own `inc=place-rels` fetch (no sibling silently-zero guard), so a floor would false-fail a healthy reload whose collection simply lacks MB studio data; its broken-fetch tripwire is the client parse unit test, not a runtime warn (a "0 studios" warn would cry wolf every reload). `getReleasesByStudio` rolls track-level studios up to the Release via `HAS_TRACK` so they surface through `GET /explore/studio/:name`. The captured coordinates are exposed for the map (#342) by `GET /explore/recording-locations` (every coord-bearing Studio + per-studio release/track counts), with studio-level coverage at `/stats.studiosWithCoordinates` (all-studios denominator, un-gated like `tracksWithMbStudio`). `/track-recording-places/reset` deletes the MB studio edges + the marker but **leaves Studio nodes and their coordinates intact** (shared, name-keyed, location is a physical fact not run output).

12. **`MB_RELEASED_IN` is physical-pressing reach, not availability footprint — digital-only events are dropped + the medium is tagged (#458).** A release-group with a worldwide **digital** edition makes MusicBrainz enumerate one ISO release-event per country storefront (St. Vincent's _Marry Me_: 206 distinct ISO countries, all dated `2007-07-10`), which saturates any distinct-country count over `MB_RELEASED_IN`. The Discogs→MB match and the `:Country`/`:Region` split (#441) are both correct — the inflation is real storefront enumeration, not dirty data — so the fix is at the data, not the join: `enrichMbReleaseEvents` drops events whose formats are **digital-only** (`isDigitalOnlyRelease`, `transforms.ts`) before counting/writing, so the relationship is physical-pressing reach by construction (the naive count is correct, no trap). Each surviving edge also carries a derived `formatFamilies` array — the raw `formats` normalized onto a small physical-medium vocabulary (`vinyl`/`cassette`/`cd`/`8-track`/`reel`/`other`) by `normalizeFormatFamilies` — kept **alongside** the verbatim `formats` (the #333 derived-`instrument` pattern), so "how many countries got a vinyl pressing" stays a clean query. **`DIGITAL_FORMATS` is an EXACT-match set (`Digital Media`/`File`), never a substring test** — a substring `'digital'` check would catch _Digital Compact Cassette_ (DCC), a physical tape, and wrongly drop it. Physical-but-niche formats (DVD, Blu-ray, MiniDisc, DAT, Shellac) are **kept** and bucket to `other` — only digital is dropped. An all-digital release-group writes zero edges but is still stamped `mbReleaseEventsFetchedAt`, so it's excluded from re-selection like any no-events master (idempotent, not re-fetched forever). The `mastersWithReleaseEvents` `/stats` figure is an ungated `EXISTS` count, so it only moves for 100%-digital masters — correctly (they have no physical pressing reach). No public route counts `MB_RELEASED_IN` today (`/explore/releases/most-pressed` reads Discogs `RELEASED_IN`), so this is forward-safety for future reach analytics; existing edges pick up the new shape on the next re-enrich (full reload or `/mb-release-events/reset` + `/enrich`).

**Regression guards — what breaks if you change X:**

| Change                                                                | Impact                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Make `DIGITAL_FORMATS` a substring match instead of exact (#458)      | `Digital Compact Cassette` (DCC) and other physical tapes are wrongly classified digital and dropped        |
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
- **Musician/Artist resolution is by shared `discogsId`, not fuzzy matching (#330).** A person credited as a session `Musician` and listed as a primary `Artist` is linked via `SAME_PERSON_AS` when they share a `discogsId` — written inline on ingest and backfilled exhaustively by the standalone `person-reconciliation` pass (so late-arriving Artist nodes get linked without a re-ingest). Group membership (`MEMBER_OF`) comes from Discogs `members[]` via the `group-members` pass. The explore queries (`getReleasesByMusician`, `getSharedMusicians`) traverse these edges to consolidate aliases; `getReleasesByMusician` also expands `MEMBER_OF` **one way only** — a member's results include their group's records (an inferred involvement, now **temporally guarded** by the Wikidata P463 tenure, #424: out-of-tenure group records are dropped where the years are known, kept where unknown — the member's own credits are never dropped), but a group query is NOT expanded to its members' solo credits (which would over-attribute the group — PR #330 review). `/stats.samePersonLinks` (verify-gated at 100%) + `memberOfEdges`/`groupsWithMembers` make the result measurable. **Still unresolved:** name-only (`id === 0`) credits carry no `discogsId`, so they don't collapse — that needs Discogs `namevariations` (a deliberate follow-up). There is no fuzzy name matching by design.
- **Lyrics are best-effort.** LRCLIB and Genius coverage is incomplete. Missing lyrics are acceptable — the `lyrics` property on `Track` is nullable by design.
- **Lyrics resolution is a five-state, confidence-gated model (issues #246, #248).** `lyricsStatus ∈ {resolved, instrumental, probable-instrumental, low-confidence, not-found}` distinguishes "no lyrics exist" from "we missed them" from "we found the wrong song". `instrumental` (LRCLIB's authoritative flag) and `probable-instrumental` (the AcousticBrainz `voiceInstrumental` signal we already store) are **terminal** — excluded from the candidate query and short-circuited before any Genius call, killing the wasted-call/403-spam loop. `not-found` and `low-confidence` stay candidates, throttled per staleness window. `probable-instrumental` depends on `track-acousticbrainz` having run first, which finishes after `lyrics` in a fresh reload — so it mostly classifies on a later staleness re-run (lyrics is deliberately not made a dep of that ~2.5hr stage). `/stats` reports coverage over the non-instrumental denominator plus a `lyricsFunnel`; coverage keys on `lyrics IS NOT NULL` so tracks enriched before the field existed still count.
  - **Match confidence (#248).** Before a candidate's lyrics are stored, `enrichLyrics` scores the match with `scoreLyricsMatch` (`src/enrichment/match-confidence.ts`, the shared Sørensen–Dice title/artist similarity + duration tolerance also used by the MusicBrainz matcher): `confidence = min(titleSim, artistSim) × (duration disagrees ? 0.5 : 1)`, where an absent axis or unknown duration scores 1.0 (absence is not evidence against — this keeps Genius, which never carries a duration, viable). A match at or above `LYRICS_CONFIDENCE_THRESHOLD` (env, default **0.85**, fails safe to the default on garbage/out-of-range) is stored `resolved` with `lyricsConfidence` + `lyricsMatchedTitle`/`lyricsMatchedArtist` provenance; below it is stamped `low-confidence` (the lyric **text is dropped**, `lyrics` stays NULL so honest coverage and the fulltext index stay clean) with the score + provenance recorded so the doubt is visible and auditable. This is the gate that prevents the #31 wrong-song corruption class (artist matched, wrong song) and the live/remix-with-different-lyrics class (duration mismatch). The `GeniusClient` additionally pre-filters obvious title mismatches before the page scrape (a strict subset of this gate). `low-confidence` is **non-terminal** — a better catalog match or a retuned threshold can upgrade it later — and stays in the honest coverage denominator. Cross-source LRCLIB↔Genius agreement (the issue's signal #3) is a deliberate follow-up: the short-circuit flow never fetches both for one track.
  - Full rationale in [`docs/adr/0001-lyrics-resolution-strategy.md`](../../docs/adr/0001-lyrics-resolution-strategy.md).
- **Enrichment markers are `*FetchedAt` timestamps, not booleans (issue #89).** Every external-source enrichment stamps `<source>FetchedAt = datetime()` after each attempt. The candidate query selects a node only when it **still lacks the data** (e.g. `recordingMbid IS NULL`, `NOT EXISTS { (a)-[:ORIGIN_COUNTRY]->() }`, `lyrics IS NULL`) **and** its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30). So a node a source had no data for is retried at most once per window — picking up newly-added coverage or a fixed client without a full re-ingest — while already-enriched nodes are never re-fetched automatically. Transient errors don't stamp (they retry next run); the `/admin/<x>/reset` routes still force a full re-fetch. **Caveat the in-stage retry sweep (#455) closes for `lyrics`:** in a _fresh_ reload there is no later run in the same job, so a transient LRCLIB timeout used to harden into a durable `not-found` gap until an operator re-ran the stage (the incident: lyrics coverage 73%→64.3%). `lyrics` now runs a bounded in-run retry sweep (`LYRICS_RETRY_ROUNDS`, default 2) over its own transient failures before completing, so a blip self-heals in-run; this `*FetchedAt` staleness window remains the backstop for everything the sweep can't (non-`lyrics` stages, or failures persisting past `maxRounds`). The marker is set server-side via `datetime()`, so there is no client-clock dependency. Helper: `src/enrichment/staleness.ts`. This `*FetchedAt` throttle is the **throttled-recheck** half of the two-state model; the **terminal-empty** half (a permanent marker so a never-fillable absence — instrumental, confirmed non-group — is excluded for good, counted `exhausted` not `skipped`) is the `TERMINAL_EMPTY` runner outcome (#367, [ADR 0003](../../docs/adr/0003-enrichment-terminal-vs-throttle.md)). Terminal is opt-in per source; today `lyrics` (`lyricsStatus` enum), `group-members` (`notAGroup`), and `track-acousticbrainz` (`acousticBrainzExhausted`, #384 — a batch-local marker outside the runner contract, since it is an off-contract bulk stage) use it, the rest are throttle-only.
- **No time signature from AcousticBrainz.** AcousticBrainz low-level rhythm descriptors do not expose a reliable categorical time signature. The `t.tempo` / `t.musicalKey` / `t.musicalScale` fields are trustworthy; a `time_signature` integer equivalent to Spotify's is not available without self-hosted Essentia analysis on the actual audio files.
- **AcousticBrainz audio features are estimates, not Spotify values.** `danceabilityEstimate` and `voiceInstrumental` are AcousticBrainz high-level classifier outputs — a different model trained on different data from Echo Nest/Spotify. They are labelled `...Estimate` deliberately and must never be presented as equivalent to Spotify features.
- **Deezer is an independent, ISRC-keyed audio-feature source.** `deezerBpm` and `deezerGain` (a loudness figure) are stored under `deezer*` property names rather than overwriting `tempo`/`loudnessDb`, so the source stays traceable and the two BPM figures can be compared. Deezer is an admin-route enrichment (not part of `runIngestion`) that depends on `isrc` being populated first by `track-musicbrainz` enrichment. Deezer returns `0` for unknown values — these are coerced to null before storing. `deezerGain` is a ReplayGain-style loudness figure; it is not the same metric as `loudnessDb`.
- **`formats[].qty` is a string in the API.** The Discogs API returns `qty` as a string (e.g. `"1"`), not a number. Always `parseInt` before storing. Do not assume it is numeric.
- **Track `duration` is frequently empty string.** The API returns `""` for tracks without listed duration. Treat `""` as null — do not store the empty string.
- **`basic_information` in collection responses is incomplete.** The collection endpoint's `basic_information` object omits `country`, `extraartists`, and other fields. Always fetch the full release via `GET /releases/{id}` before ingesting.
- **The stats-snapshot timer doubles as the Aura keep-warm (issue #103).** `startStatsSnapshots` (`src/observability/stats-snapshot.ts`) runs real Cypher (`getStats`) on pod startup and every 6h, which is what holds AuraDB Free open — a connectivity check does not reset its 72h auto-pause timer, a real query does. `MAX_SNAPSHOT_INTERVAL_MS` is capped below `AURA_PAUSE_WINDOW_MS` (72h) with a guarding unit test so the interval can't be configured out of the window. Keep-warm rides the pod, so it only runs while the k3s node is up; a long `power:off` intentionally lets Aura pause (manual resume — see infra/RUNBOOK.md "Keeping Aura warm").
- **`CREDITED_ON` deduplication on re-run.** Because MERGE on a relationship between two nodes does not have a separate key — it matches by the full (from, type, to) pattern — re-running ingest updates relationship properties in-place. This is correct and intentional.
- **Rate limiter keys on `cf-connecting-ip` only when `TRUST_CF_CONNECTING_IP=true` (issue #287).** Behind Cloudflare the direct peer (`request.ip`) is a shared CF-edge/NodePort-SNAT address, so all public traffic would otherwise collapse into one bucket. The flag is off by default (local dev / forks key on the real peer) and is **only safe with the CF-only SG lockdown** (`restrict_app_to_cloudflare`) in front — otherwise the header is spoofable. Authenticated admin calls are exempt from the limiter (`allowList` → `isAuthorizedAdmin`) so a public flood can't 429 the operator out; a wrong/absent token is still limited. See `buildRateLimitOptions` in `src/server.ts`.
