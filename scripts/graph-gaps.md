# Graph Gaps & Proposed Solutions

Analysis of what the 19 social-query questions revealed about the current data model.
Gaps are grouped by category: some are fixable today with existing data, others require
new data sources.

---

## A — Data Type & Storage Issues

_Wrong shape for the data we already have. Fixable with a migration + ingestion change._

---

### A1. Duration stored as a string, not an integer

**Queries affected:** Q3 (tracks > 12 min)

**Current workaround:**

```cypher
WITH split(t.duration, ':') AS parts
WHERE size(parts) = 2
WITH toInteger(parts[0]) * 60 + toInteger(parts[1]) AS totalSeconds
WHERE totalSeconds > 720
```

Every duration query requires this four-line parse. Tracks with missing or
malformed durations (empty string, `""`, multi-part like `"1:02:34"`) are silently dropped.

**Fix applied (PR #48):**
`durationSeconds: Integer` is now stored on Track nodes at ingestion time.
Queries use it directly:

```cypher
WHERE t.durationSeconds > 720
```

---

### A2. Release year stored as `0` instead of `null` when unknown

**Queries affected:** Q5 (release gap), Q6 (genre by date), Q11b (avg title length)

**Fix applied (PR #34):**
The pressing year is now stored as `r.pressingYear` (renamed from `r.year`). At ingestion,
`release.year === 0` is treated as absent and stored as `null`, so standard `IS NOT NULL`
checks work without extra guards.

```cypher
WHERE r.pressingYear IS NOT NULL
```

---

### A3. Musician nodes include non-musicians — no role category

**Queries affected:** Q3 (writing credit filter), Q4 (cross-genre collaborator)

**Current workaround:**
Queries manually exclude non-musical roles using a long chain of `NOT CONTAINS` checks:

```cypher
AND NOT toLower(co.role) CONTAINS 'manag'
AND NOT toLower(co.role) CONTAINS 'photog'
AND NOT toLower(co.role) CONTAINS 'artwork'
AND NOT toLower(co.role) CONTAINS 'sleeve'
...
```

This is brittle — any new role string not in the list leaks through.

**Fix applied (PR #49):** `roleCategory` is now set on all `CREDITED_ON` relationships at
ingestion, derived from a canonical lookup table mapping role substrings to categories
(`performer`, `composer`, `producer`, `engineer`, `visual`, `crew`).

```cypher
WHERE co.roleCategory IN ['performer', 'composer']
```

---

## B — Missing Enrichment Fields

_We have the keys to fetch this data from Discogs; we just haven't done so yet._

---

### B1. No `originalYear` — reissues corrupt chronological queries

**Queries affected:** Q5 (release gap), Q6 (genre timeline)

**Fix applied (PR #34):** `r.originalYear` is now enriched from `GET /masters/{masterDiscogsId}`
as a post-ingestion step. Queries use `coalesce(r.originalYear, r.pressingYear)` so reissues
correctly reflect their original release year rather than the pressing date.

---

### B2. No genre/style profile on Artist nodes — can't compare to out-of-collection artists

**Queries affected:** Q1 (similar to Sinatra)

**Current state:** Genres and styles live only on Release nodes. To find artists similar to
someone not in the collection (Sinatra), we had to hand-craft his profile as a hardcoded
`WITH` clause from a manual Discogs API lookup.

**Proposed fix — Option 1 (graph model):**
After ingesting releases, run a post-step that aggregates genre/style onto the Artist node:

```cypher
MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)-[:IN_GENRE]->(g:Genre)
WITH a, collect(DISTINCT g.name) AS genres
SET a.genres = genres
```

This enables:

```cypher
MATCH (a:Artist {name: 'Frank Sinatra'}) RETURN a.genres
```

even if he has no releases in the collection (populated from an artist-page fetch).

**Option 2 (relationship model):**
Add `(Artist)-[:KNOWN_FOR_GENRE]->(Genre)` edges derived from all a artist's Discogs
releases (not just the ones in the collection). Richer for graph traversal but heavier
to maintain.

---

### B3. No artist nationality or origin

**Queries affected:** Q10 (international reach — pressing country ≠ origin)

**Current state:** `FROM_COUNTRY` tracks where the vinyl was _manufactured_, not where the
artist is _from_. The two questions are quite different and the country field conflates them.

**Proposed fix:**
Fetch `profile` from `GET /artists/{discogsId}` and parse or store the `realName` and
nationality fields that Discogs sometimes includes. Alternatively, add `artistCountry`
directly on the Artist node from the Discogs artist page.

---

## C — Missing Structural Relationships

_The data exists in Discogs or is derivable from what we have, but isn't modelled as graph edges._

---

### C1. No explicit version/remix relationship between tracks

**Queries affected:** Q9 (most versions), Q13 (most remixes)

**Current state:** Version detection relies on stripping parenthetical suffixes with APOC
regex — `apoc.text.regreplace(t.title, '\s*\([^)]*\)\s*$', '')`. This misses:

- Bracket variants: `[Live at Fillmore]`, `[Radio Edit]`
- Prefix variants: `"Live - Just Like A Woman"`
- Discogs-specific: `"Version 1"` / `"Version 2"` as standalone titles (no parenthetical)
- Double-parenthetical: `"Song (Remix) [Bonus Track]"`

**Proposed fix:**
Run a post-ingestion step that creates explicit relationships:

```
(t:Track)-[:IS_VERSION_OF {versionType: 'remix'|'live'|'acoustic'|'demo'|'alternate'|'instrumental'}]->(t2:Track)
```

Matching logic: normalized base title equality across releases, with `versionType` derived from
the parenthetical content. Queries then navigate the relationship instead of string-munging.

> **Status (#196): implemented, then dropped.** The `IS_VERSION_OF` stage shipped but on the live
> collection yielded only 23 links, **all `versionType: "unknown"`** and all byte-identical-title
> pairs — i.e. the same recording reappearing on an album + compilation, never the remix/live
> variants this was meant to capture. The byte-exact title match only ever fires on duplicates, so
> the stage was removed in #196 (docs/schema reconciled to match). If revived, anchor on
> `recordingMbid` equality or shared-master grouping (both already populated) rather than title.

---

### C2. No cover song relationship

**Queries affected:** Q9 (most versions includes covers), Q10 (international reach counts coincidentally same-titled tracks as "covers")

**Current state:** Cover detection is purely by title match — "Let's Dance" by Ramones and
"Let's Dance" by David Bowie are treated as the same song because they share a title, but
they're entirely different songs. Conversely, Joe Cocker's "With A Little Help From My
Friends" is correctly grouped with The Beatles' original only because the title is identical.
There's no ground truth for "this recording is a cover of that original."

**Proposed fix:**
Add a `COVERS` relationship between tracks or between artists:

```
(t:Track)-[:COVERS {originalArtist: 'The Beatles', originalYear: 1967}]->(tOrig:Track)
```

or at artist level:

```
(a:Artist)-[:COVERED]->(a2:Artist)
```

Source: MusicBrainz has comprehensive cover relationships. Alternatively, Discogs
`extraartists` credits sometimes include "Performed By [Originally By]" annotations
that could be parsed.

---

### C3. No sampling relationship

**Queries affected:** Original Q9 ("sampled from modern hip-hop" — had to abandon entirely)

**Current state:** Completely unqueryable from the graph. No Discogs field carries sampling
information.

**Proposed fix:**

- **Best source:** [WhoSampled](https://www.whosampled.com) — comprehensive but no public API.
  Would require scraping or a partnership.
- **Open source:** MusicBrainz has `samples` relationship type in its data model.
- **Graph model:** `(t:Track)-[:SAMPLED_BY]->(t2:Track)` or
  `(t:Track)-[:SAMPLES]->(t2:Track)` with `sampleType: 'loop'|'interpolation'|'replay'`.

---

### C4. No `isVariousArtists` flag on Release

**Queries affected:** Q4 (cross-genre collaborator — Various Artists releases inflate genre counts)

**Fix applied (PR #48):** `r.isVariousArtists: Boolean` is now set at ingestion when the
primary artist matches Discogs IDs 194 or 355. Queries can filter directly:

```cypher
WHERE NOT r.isVariousArtists
```

---

## D — Lyrics Quality

_Filed as issue #31. Summarized here for completeness._

---

### D1. All Genius-sourced lyrics are corrupted

**Queries affected:** Q2 (potato — lrclib filter required), Q7 (fewest words — garbage filter required), any full-text search

**Current workaround:** `AND t.lyricsSource = 'lrclib'` scoped to every lyrics query;
additional `NOT toLower(t.lyrics) CONTAINS 'contributor'` guards.

**Impact:** 460 of 1,946 enriched tracks are unreliable. Full-text search can match
800 KB of scraped Proust as a "lyric."

**Fix:** Issue #31. Short term: null out all Genius data. Long term: fix scraper + re-enrich.

---

### D2. No `isInstrumental` flag on Track

**Queries affected:** Q7 (fewest words — instrumental tracks should be out-of-scope but may have lyrics = null or lyrics = garbage)

**Fix applied (PR #48):** `t.isInstrumental: Boolean` is now set at ingestion when the
track type is `"index"` or the title contains common instrumental markers
(`"(Instrumental)"`, `"(Reprise)"`, `"Overture"`, etc.).

---

## E — Visual & Sensory Metadata

_Requires external enrichment — not in Discogs._

---

### E1. No cover art analysis or tagging

**Queries affected:** Q8 (naked ladies), Q12 (car on cover)

**Current state:** Only `thumbUrl` (150px Discogs CDN URL) is stored. Both visual questions
required exporting the URL list for manual LLM review — the graph cannot answer them at all.

**Proposed solutions:**

| Option                                                                                                     | Effort     | Quality                                                         |
| ---------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| Run multimodal LLM (Claude, GPT-4V) on each cover at ingestion; store `coverDescription` and `coverTags[]` | Medium     | Good for known albums                                           |
| AWS Rekognition / Google Vision label detection                                                            | Medium     | Reliable for objects (cars, people) but misses artistic context |
| Fetch cover descriptions from AllMusic, Rate Your Music, or Discogs community notes                        | High       | Rich but inconsistent                                           |
| Manual user-provided tags                                                                                  | Low effort | Sparse                                                          |

**Recommended:** At ingestion, run the `thumbUrl` through a multimodal LLM with a prompt like
_"Describe this album cover in 1–2 sentences and list 5–10 descriptive tags."_
Store `r.coverDescription: String` and `r.coverTags: String[]`.

```cypher
// Query becomes:
MATCH (r:Release)
WHERE ANY(tag IN r.coverTags WHERE tag CONTAINS 'car' OR tag CONTAINS 'automobile')
  AND NOT r.artistName CONTAINS 'Cars'
RETURN r.title, r.artist, r.coverDescription, r.thumbUrl
```

---

### E2. No audio features — time signature, tempo, key, energy

**Queries affected:** Q14 (7/8 time signature — completely unanswerable)

**Current state:** The query surfaces stylistically adjacent releases (Prog Rock, Fusion)
as a proxy, and relies on hardcoded external knowledge for specific tracks. No audio
property exists in the graph.

**Proposed solutions:**

| Source                                       | Data available                                                                | Access                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Spotify Web API** — `/audio-features/{id}` | `time_signature`, `tempo`, `key`, `mode`, `energy`, `valence`, `danceability` | Free, rate-limited. Requires matching Discogs track to Spotify track. |
| **MusicBrainz**                              | Some time signatures, recording metadata                                      | Free, open. Match via ISRC or title+artist.                           |
| **AcousticBrainz** (deprecated 2022)         | Full audio feature set                                                        | Historical data dump available                                        |

**Recommended:** Spotify audio features are the most accessible and comprehensive.
Match tracks by `artist + title` search, confirm with duration proximity, then store:

```
t.spotifyId, t.timeSignature, t.tempo, t.key, t.mode, t.energy, t.valence
```

Query then becomes:

```cypher
MATCH (t:Track) WHERE t.timeSignature = 7
MATCH (r:Release)-[:HAS_TRACK]->(t)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
RETURN t.title, a.name, r.title, t.tempo
```

---

## F — Geographic Data Quality

---

### F1. Country codes are non-standard regional groupings, not ISO countries

**Queries affected:** Q10 (international reach)

**Current state:** Country values are Discogs market codes: `"US"`, `"Europe"`,
`"USA & Canada"`, `"UK & Europe"`, `"Worldwide"` — not ISO 3166-1 codes.
This makes geographic queries imprecise: `"USA & Canada"` and `"US"` can't be
compared, and `"Europe"` covers 44 countries.

The practical result: the maximum per-track international reach in a 196-release
collection is 2 (one US pressing + one European pressing of the same title), which
is an uninformative tie across many tracks.

**Proposed fix — Option 1 (normalization):**
At ingestion, map Discogs country strings to a canonical set and potentially split
multi-country values into separate `Country` nodes with a `(Release)-[:DISTRIBUTED_IN]->(Country)`
relationship (distinct from `FROM_COUNTRY` which remains the single pressing origin).

**Option 2 (artist nationality as proxy):**
Use `artistCountry` (see B3) to answer the spirit of the question — "which song has
the widest geographic artistic spread" — rather than pressing geography.

---

## Summary Table

| Gap                            | Questions   | Effort                               | Recommended Fix                     |
| ------------------------------ | ----------- | ------------------------------------ | ----------------------------------- |
| A1. Duration as string         | Q3          | ✅ Implemented (PR #48)              | `durationSeconds: Integer` on Track |
| A2. Year = 0 not null          | Q5, Q6, Q11 | ✅ Implemented (PR #34)              | `pressingYear`; null when year is 0 |
| A3. No role category           | Q3, Q4      | ✅ Implemented (PR #49)              | `roleCategory` on CREDITED_ON       |
| B1. No originalYear            | Q5, Q6      | ✅ Implemented (PR #34)              | Enriched from master release API    |
| B2. No genre on Artist         | Q1          | Medium — post-ingestion aggregate    | Aggregate onto Artist node          |
| B3. No artist nationality      | Q10         | Medium — Discogs artist page         | `artistCountry` on Artist           |
| C1. No version relationship    | Q9, Q13     | Medium — post-ingestion step         | `IS_VERSION_OF` relationship        |
| C2. No cover song relationship | Q9, Q10     | High — needs MusicBrainz             | `COVERS` relationship               |
| C3. No sampling relationship   | Q9          | High — no free API                   | WhoSampled / MusicBrainz            |
| C4. No Various Artists flag    | Q4          | ✅ Implemented (PR #48)              | `isVariousArtists` on Release       |
| D1. Genius lyrics corrupt      | Q2, Q7      | Medium (issue #31)                   | Fix scraper, re-enrich              |
| D2. No instrumental flag       | Q7          | ✅ Implemented (PR #48)              | `isInstrumental` on Track           |
| E1. No cover art tags          | Q8, Q12     | Medium — multimodal LLM at ingestion | `coverTags[]` on Release            |
| E2. No audio features          | Q14         | High — Spotify API match             | Spotify audio features              |
| F1. Non-standard country codes | Q10         | Low — normalization map              | ISO 3166 codes + region split       |
