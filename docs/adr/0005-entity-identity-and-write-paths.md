---
status: accepted
---

# Entity identity: a Discogs spine, ISO-keyed places, and one canonical write path per entity — not per-source keys re-applied by convention

## Context

The graph is built by one ingestion loop plus ~20 enrichment stages, each a repository in
[`src/db/`](../../services/graph-service/src/db/) that writes its **own** Cypher `MERGE`. The
collection is a Discogs collection; MusicBrainz, Wikidata, AcousticBrainz, Deezer, LRCLIB and Genius
hang off it. Identity grew the way the codebase grew — **incrementally, per-source, across many
parallel sessions** — and #428 asked whether that has produced a duplicate-identity problem worth a
backbone refactor.

A read-only measurement pass against **production Aura** (2026-06-17) plus a full write-site audit
answered both halves, and the answer is not the one #428 anticipated:

1. **The canonical keys are mostly sound.** Every spine entity (`Release`/`Master`/`Label`/`Artist`)
   is `discogsId`-unique with zero duplicates; `Work` is cleanly MusicBrainz-MBID-keyed; even the
   constraint-less `Track` composite key and the soft `Musician` key show **zero** deterministic
   duplicates in prod (the person question #428 set out to answer — see the appendix). Person
   identity does **not** need a refactor.
2. **The real weakness is not the keys — it is that the rules are enforced nowhere.** Each writer
   applies normalization, identity precedence and provenance tagging _by convention_. With no shared
   chokepoint, the rules **drift writer-to-writer**, and a later session adding a writer silently
   skips a rule the original applied.

The canonical proof is **Country**. A Discogs→ISO normalization map (`normalizeCountry`,
[`transforms.ts`](../../services/graph-service/src/ingestion/transforms.ts), issue 40) has existed
for a long time, but **only one of Country's four writers calls it.** The other three were added by
later stages. The result: the same physical country fragments into two nodes that never join — a
British artist's `ORIGIN_COUNTRY` points at `GB`, a record pressed in Britain's `RELEASED_IN` points
at `UK`, and no query bridges them (proof in the appendix).

This ADR fixes the identity backbone **and** the discipline that keeps it honest. It does **not**
touch the enrichment runner (#222), the scheduler/lanes (#176), the `*FetchedAt` staleness contract
(#89), or the reload verify gate (#178) — those mechanics work and are out of scope.

## Decision

### The four identity regimes

| Regime             | Entities                               | Canonical key                  | Source of the key       |
| ------------------ | -------------------------------------- | ------------------------------ | ----------------------- |
| Discogs spine      | `Release`, `Master`, `Label`, `Artist` | `discogsId` (UNIQUE)           | Discogs (the spine)     |
| MusicBrainz-native | `Work`                                 | `mbid` (UNIQUE)                | MB (no Discogs concept) |
| Composite-derived  | `Track`                                | `(position, releaseDiscogsId)` | Discogs (per-release)   |
| Controlled vocab   | `Genre`, `Style`, `Country`, `Studio`  | a source-independent code/name | normalized at write     |

`Musician` straddles the spine: it is `discogsId`-keyed when Discogs catalogues the person, and
falls back to `name` (uncatalogued `id===0`) or `musicbrainzId` (MB-only performers) — see the
per-entity decisions.

### Canonical keys and crosswalk, per entity (measured 2026-06-17, prod)

| Entity      | Canonical key                   | Constraint            | Deterministic dupes | Cross-source crosswalk (persisted)       |
| ----------- | ------------------------------- | --------------------- | ------------------- | ---------------------------------------- |
| Release     | `discogsId`                     | UNIQUE                | 0                   | `barcode` (54%)                          |
| Master      | `discogsId`                     | UNIQUE                | 0                   | — (MB release-group MBID **discarded**)  |
| Label       | `discogsId`                     | UNIQUE                | 0                   | —                                        |
| Artist      | `discogsId`                     | UNIQUE                | 0                   | `musicbrainzId` 96.6%, `wikidataQid` 90% |
| Work        | `mbid`                          | UNIQUE                | 0                   | `writerMbids` 99%                        |
| Track       | `(position, releaseDiscogsId)`  | none (Aura Free)      | 0 (0 malformed)     | `recordingMbid` 85%, `isrc` 45%          |
| Musician    | `discogsId` \| `name` \| `mbid` | none                  | 0                   | `musicbrainzId` 84% of catalogued        |
| Studio      | `name`                          | **none (anomaly)**    | 0 exact, 2 variants | `musicbrainzPlaceId` 46%, coords 29%     |
| Genre/Style | `name`                          | UNIQUE                | 0                   | — (single-source vocab)                  |
| Country     | `name` → **ISO 3166-1 alpha-2** | UNIQUE (on wrong key) | **fragmented**      | — (no ISO key today)                     |

### The seven laws

Identity (what the key is):

1. **Discogs ID is the spine.** The collection is a Discogs collection; every spine entity keys on
   `discogsId`. MusicBrainz is the bridge, not the spine.
2. **A foreign key is canonical only where Discogs has no concept.** `Work` (a composition) is
   MB-MBID-keyed because Discogs models no composition. This is the _only_ such case.
3. **Joins are deterministic on shared IDs (`discogsId`/MBID/ISRC/QID/ISO), never fuzzy
   name-matching.** This is the project's existing law; it stays law.
4. **Multi-source vocabulary keys on a source-independent code, not raw source text.**
   Single-source vocab (`Genre`/`Style`, Discogs-only) may key on `name`; a multi-source dimension
   (`Country`) must key on a controlled code (ISO 3166), or the sources fragment it.
5. **Cross-source IDs are persisted as crosswalk attributes, never used-and-discarded.**
   `Artist.musicbrainzId`, `Track.recordingMbid`/`isrc`, `Studio.musicbrainzPlaceId` do this;
   `Master` discarding its MB release-group MBID is the one violation.

Enforcement (where the rule lives — the half that makes a foundation _sustain_):

6. **One canonical write path per multi-writer entity.** Any node or edge written by more than one
   repository gets a single `mergeX` helper that owns the normalization + `MERGE`; repositories call
   the helper, never a raw `MERGE (:X …)`. (The `CREDITED_ON` writers already do this right — Discogs
   ingest and the MB track-credits stage both route role text through the shared
   `parseRoleCategory`/`parseInstrument`/`parseDisplayRole`. `Country` and `Studio` are the
   violations.) Single-writer entities (`Release`, `Work`, …) are already de-facto chokepointed and
   are deliberately **not** wrapped in new abstractions — sustainability over ceremony.
7. **Provenance is uniform.** Every edge writer sets `source` (`"discogs"`/`"musicbrainz"`/
   `"wikidata"`); an "untagged" edge stops being a possible state.

### Per-entity decisions

- **Country → ISO 3166-1 alpha-2, with a separate `:Region` concept.** Normalize every Discogs
  country string to its ISO code at the write path (the existing `normalizeCountry` map, completed
  and applied at _all_ writers); multi-country Discogs markets (`UK & Europe`, `Scandinavia`,
  `USA & Canada`, `Worldwide`) are a genuinely different thing — a regional-pressing SKU — and become
  `:Region` nodes so the `:Country` space stays pure ISO. This collapses the `GB`/`UK`,
  `DE`/`Germany`, `JP`/`Japan` splits.
- **Studio → add the missing `UNIQUE(name)` constraint + canonicalize on the write path.** Studio is
  the only name-keyed node lacking the uniqueness constraint `Genre`/`Style`/`Country` all have; with
  0 exact duplicates today it applies cleanly, and a trim/case-fold in the `mergeStudio` helper
  collapses the 2 case/space variants the two writers produced.
- **Master → persist the MB release-group MBID.** `mb-release-events` already resolves it to fetch
  events; store it (law 5) instead of re-resolving every reload.
- **Track → document the convention-only composite key.** Aura Free cannot enforce a node-key
  constraint; the composite key is a convention, and prod confirms it holds (0 duplicates, 0
  malformed of 2,108). It is sound as-is.
- **Musician / Release → keep as-is.** Measured: 0 deterministic duplicates. The `Musician` softness
  is working; `Release` flows MB data via `Track` and needs no album-level MB bridge today (a Release
  MBID bridge is **deferred**, not adopted).
- **Person identity answers and supersedes #428.** Discogs spine, MB as crosswalk; 0 deterministic
  duplicates, 0 active #426 collisions. No Person backbone refactor.

### The guard

A dependency-free unit test over `src/db/**` fails CI when a raw `MERGE (c:Country …)` or
`MERGE (s:Studio …)` appears outside its canonical helper, or an edge writer omits `source`. This is
the wall of defense that survives the next parallel session — the same fail-loud, self-sustaining
posture as the repo's other guards, not a heavyweight framework.

## Consequences

- **The fixes are tracer-bullet sub-issues, not this PR.** This ADR is the decision; implementation
  is split (via the issue tracker) into: (1) the canonical write-path chokepoint + CI guard
  **[keystone]**; (2) Country → ISO + `:Region`; (3) uniform `source` provenance; (4) Studio
  `UNIQUE(name)` + canonicalization; (5) Master release-group-MBID crosswalk. Sub-issues 2–5 ride on
  the chokepoint from (1).
- **Migration is a wipe-and-reload, never an in-place migration.** The whole graph is re-derivable
  from its external sources, so an identity/constraint change that would be terrifying on a
  production OLTP store is cheap here: `POST /admin/reset?confirm=wipe-all`, then reload. This
  uniquely de-risks every key/constraint change above.
- **"Untagged" provenance disappears.** Once Discogs edge writers set `source:"discogs"`, the
  `/stats` `untagged` bucket goes to zero and edges become source-attributable.
- **No new abstraction tax on single-writer entities.** Law 6 is scoped to multi-writer entities by
  design; the ~10 single-writer repositories are left exactly as they are.
- **The mechanics stay untouched.** The runner (#222), scheduler/lanes (#176), `*FetchedAt` contract
  (#89) and verify gate (#178) are explicitly out of scope.

## Alternatives rejected

- **MusicBrainz MBID as the person/spine key.** The collection _is_ a Discogs collection; every node
  enters through Discogs ingest. MB coverage is high but not total, and MB-as-spine would strand
  every Discogs-only entity. Discogs is the spine; MB is the bridge (law 1).
- **Fuzzy name-matching to merge the 62 name-ambiguous people / 2 studio variants / `UK`↔`GB`.**
  Forbidden by law 3. The 62 are precisely the cases that cannot be merged deterministically; ISO
  normalization fixes the country split without any fuzzy match.
- **Uniqueness constraints alone.** A constraint cannot catch normalization drift: `UK` and `GB` are
  both valid distinct strings, so a `UNIQUE(name)` on Country would happily keep both. The drift is a
  _write-path_ problem; only the chokepoint + guard close it.
- **A post-hoc Country reconciliation stage** (à la `person-reconciliation`). A band-aid: it cleans
  up after the fact and adds a stage to maintain. Prevention at the write path is cheaper and durable.
- **Exploding regions into member countries.** `UK & Europe → GB + EU members` maximizes joinability
  but loses the regional-SKU fact and needs a fuzzy region→members table (`Europe` is ambiguous). A
  separate `:Region` concept keeps both facts clean.

## Measurement appendix (production Aura, read-only, 2026-06-17)

Node census: `Musician` 3070, `Track` 2108, `Work` 1194, `Country` 347, `Studio` 248, `Release` 196,
`Master` 188, `Label` 184, `Artist` 178, `Style` 88, `Genre` 13.

Person fragmentation (the #428 question): of 3,070 Musicians — 2,908 `discogsId`-keyed, 23 name-only
(`id===0`), 139 MB-only fallback. `SAME_PERSON_AS` reconciliation gaps: **0**. #426 name×MBID
collisions: **0**. Probable duplicates by name: 62 — of which collapsible by a deterministic MBID
join: **0** (all 139 fallbacks match no `discogsId` node by MBID → genuinely MB-only people, not
duplicates). Artist `musicbrainzId` 96.6%, `wikidataQid` 89.9%.

Per-entity integrity: `Track` 0 composite-key duplicates, 0 malformed keys of 2,108
(`recordingMbid` 85.3%, `isrc` 45.4%). `Studio` 0 exact-name duplicates, 2 case/space-variant pairs;
`musicbrainzPlaceId` 113/248, coordinates 71/248. `Master` MB release-events 159/188. `Work`
`writerMbids` 1185/1194, `WROTE` edges on 1110. Single-source vocab (`Genre`/`Style`) clean.

Country fragmentation proof — edges per node by writer:

| Node      | `ORIGIN_COUNTRY` (person) | `FROM_COUNTRY` (release) | `RELEASED_IN` (Discogs) | `MB_RELEASED_IN` (MB) |
| --------- | ------------------------: | -----------------------: | ----------------------: | --------------------: |
| `GB`      |                       326 |                        6 |                       0 |                   259 |
| `UK`      |                         0 |                        0 |                     119 |                     0 |
| `DE`      |                        22 |                        0 |                       0 |                   107 |
| `Germany` |                         0 |                        0 |                      80 |                     0 |
| `JP`      |                         3 |                        0 |                       0 |                   259 |
| `Japan`   |                         0 |                        0 |                     133 |                     0 |
| `US`      |                      1664 |                      164 |                     182 |                   794 |

`GB`/`UK`, `DE`/`Germany` and `JP`/`Japan` are the same place split across the ISO-emitting writers
(person nationality + MB events) and the raw-Discogs writer (`master-data`, `RELEASED_IN`). `US` works
only because both authorities happen to emit the token `US`. 347 Country nodes exist for ~200 real
countries; root cause is that `normalizeCountry` runs at 1 of 4 writers.

See [ADR 0003](0003-enrichment-terminal-vs-throttle.md) for the enrichment-outcome contract this ADR
deliberately leaves untouched.
