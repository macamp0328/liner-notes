# Discogs API Exploration — Findings

**Date:** 2026-05-05  
**Script:** `scripts/explore-discogs.ts`  
**Sample release:** Big Thief — _U.F.O.F._ (Discogs ID: 13570466, 2019)  
**Collection:** {DISCOGS_USERNAME} — 196 releases across 40 pages

---

## 1. Collection Endpoint

`GET /users/{username}/collection/folders/0/releases?page=1&per_page=5`

### What works as expected

- Authentication via `Authorization: Discogs token={TOKEN}` header works correctly.
- Pagination object is present: `{ page, pages, per_page, items, urls: { next, last } }`.
- `basic_information` on each release contains: `id`, `title`, `year`, `genres[]`, `styles[]`, `formats[]`, `labels[]`, `artists[]`, `master_id`, `master_url`, `thumb`, `cover_image`.

### Surprises / gaps

- **Default sort is by label, alphabetically** (`sort=label&sort_order=asc`). The pagination `next`/`last` URLs embed this. To get releases sorted by date added or title, add `?sort=added&sort_order=desc` to the query. No impact on ingestion correctness, but worth being explicit in the ingestion pipeline.
- **`basic_information.artists[].role` is always `""` (empty string)** for the primary artist. Role is only meaningful on `extraartists[]`.
- **`basic_information` omits `country` and `extraartists`** — those only appear in the full `GET /releases/{id}` response. The ingestion pipeline must fetch the full release for every record.
- Each release entry has `instance_id`, `date_added`, `rating`, and `folder_id` at the collection level — not in `basic_information`. These are collection-membership metadata, not release metadata.

---

## 2. Full Release Endpoint

`GET /releases/{release_id}`

### Field-by-field comparison — spec Section 6.4

All 13 spec-expected fields are present in the actual API response.

| Field            | Present? | Type             | Notes                                                                |
| ---------------- | -------- | ---------------- | -------------------------------------------------------------------- |
| `title`          | ✅       | string           | As expected                                                          |
| `year`           | ✅       | number (integer) | As expected                                                          |
| `country`        | ✅       | string           | e.g. `"US"`                                                          |
| `genres[]`       | ✅       | string array     | e.g. `["Rock"]`                                                      |
| `styles[]`       | ✅       | string array     | e.g. `["Indie Rock", "Folk Rock"]`                                   |
| `formats[]`      | ✅       | object array     | See format shape below                                               |
| `artists[]`      | ✅       | object array     | See artist shape below                                               |
| `extraartists[]` | ✅       | object array     | Top-level: producer, engineer, designer, etc.                        |
| `labels[]`       | ✅       | object array     | See label shape below                                                |
| `tracklist[]`    | ✅       | object array     | See tracklist shape below                                            |
| `companies[]`    | ✅       | object array     | See companies analysis below                                         |
| `images[]`       | ✅       | object array     | See image shape below                                                |
| `master_id`      | ✅       | number           | Present when a master exists; may be `0` for releases with no master |

---

## 3. Actual Field Shapes (vs Spec Assumptions)

### `artists[]` and `extraartists[]`

```json
{
  "name": "Big Thief",
  "anv": "", // artist name variation — alias used on this release
  "join": "", // join string between artists ("&", "vs.", etc.)
  "role": "", // empty for primary artists; role string for extra artists
  "tracks": "", // which tracks this credit applies to (empty = all)
  "id": 5009441,
  "resource_url": "https://api.discogs.com/artists/5009441",
  "thumbnail_url": "..." // only in full release response, not collection
}
```

**Key finding — `role` is a comma-delimited multi-value string:**  
`"Acoustic Guitar, Electric Guitar, Vocals"`, `"Bass, Drone [Bass Drone]"`, `"Technician [Studio Brain], Engineer [Assistant Engineer]"`

The spec models `instrument` as a separate property on `CREDITED_ON`. In the API there is no separate instrument field — instruments and roles are merged into a single comma-delimited `role` string. Square brackets denote role subtypes (e.g. `Drone [Bass Drone]`, `Other [Catered By]`).

**Recommendation:** Parse `role` at ingestion time. Split on `, ` to get individual roles/instruments. Store the raw `role` string on the relationship, and parse out a primary instrument where clearly identifiable. Don't try to normalize every variant at this stage.

**Key finding — `id: 0` and empty `resource_url`:**  
Some `extraartists` entries (catering staff, personal acknowledgments) have `id: 0` and `resource_url: ""`. These people exist in the liner notes but not in the Discogs artist database. Ingestion must handle `id === 0` gracefully — skip creating a node or create a stub with name only and no `discogsId`.

**Key finding — `anv` (artist name variation):**  
When an artist is credited under a name different from their canonical Discogs name, `anv` is populated. E.g. `"name": "Joe Nino-Hernes", "anv": "JN-H"`. This is the name as it appears on the sleeve. Useful for display; store as an additional property on the relationship.

### `labels[]` and `companies[]`

```json
{
  "name": "4AD",
  "catno": "4AD0129LP",
  "entity_type": "1", // numeric code (not human-readable alone)
  "entity_type_name": "Label", // human-readable type
  "id": 634,
  "resource_url": "...",
  "thumbnail_url": "..."
}
```

**`companies[]` — observed `entity_type_name` values:**

| entity_type_name             | entity_type | Meaning                                        |
| ---------------------------- | ----------- | ---------------------------------------------- |
| `Recorded At`                | 23          | Recording studio ← **this is the studio node** |
| `Mixed At`                   | 27          | Mixing studio — also a studio                  |
| `Mastered At`                | 29          | Mastering studio                               |
| `Lacquer Cut At`             | 30          | Lacquer cutting facility                       |
| `Phonographic Copyright (p)` | 13          | Copyright holder                               |
| `Copyright (c)`              | 14          | Copyright holder                               |
| `Manufactured By`            | 10          | Pressing plant                                 |
| `Distributed By`             | 7           | Distributor                                    |

**Recommendation:** The spec filters by `entity_type_name === "Recorded At"` for Studio nodes. Consider also capturing `"Mixed At"` as it often refers to the same facility or is equally valuable for relationship queries. Filter by `entity_type` numeric codes for reliability rather than string matching.

Studio data is **present** on this release (Bear Creek Studios appears twice — once for recording, once for mixing). The spec's "known gap" about studio sparsity may be less severe than feared for well-documented releases. Expect variability across the 196-release collection.

### `formats[]`

```json
{
  "name": "Vinyl",
  "qty": "1", // NOTE: string, not number
  "descriptions": ["LP", "Album"],
  "text": "Pitman Pressing" // optional free-text note
}
```

**Note:** `qty` is a **string** not a number. Parse to integer at ingestion.

### `tracklist[]`

```json
{
  "position": "A1",          // side + track number (LP format)
  "type_": "track",          // "track", "heading", "index" — NOT in spec
  "title": "Contact",
  "extraartists": [...],     // per-track credits — same shape as release-level extraartists
  "duration": ""             // OFTEN EMPTY — see note below
}
```

**Critical finding — `duration` is frequently empty:**  
All 12 tracks on _U.F.O.F._ have `duration: ""`. Duration is community-contributed and inconsistently populated on Discogs. Do not rely on it for ingestion completeness. Store when present; don't error when absent.

**`type_` field** (not in spec): Tracklist entries can be `"track"` (actual songs), `"heading"` (side headers like "Side A"), or `"index"` (for indexed-but-non-displayed tracks). Filter by `type_ === "track"` during ingestion to avoid creating Track nodes for structural headers.

**Per-track `extraartists[]`**: This is where individual musician credits live. All 12 tracks on this release have per-track credits — this is ideal graph data (individual instrument roles per track). The spec's `CREDITED_ON Musician → Release` relationship should perhaps be supplemented with a `CREDITED_ON Musician → Track` relationship for per-track credits.

### `images[]`

```json
{
  "type": "primary", // "primary" or "secondary"
  "uri": "https://...", // full-size image
  "resource_url": "...", // same as uri for images
  "uri150": "https://...", // 150px thumbnail
  "width": 600,
  "height": 595
}
```

`uri150` and dimensions are present but not in the spec. Useful: `uri150` for the graph-service API thumbnail response; `width`/`height` for frontend aspect ratio handling.

---

## 4. Extra Fields Not in Spec — Worth Capturing

| Field                                | Value                            | Recommendation                                                                                        |
| ------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `released`                           | `"2019-05-03"` (ISO date string) | Store alongside `year` — gives day-precision for sorting. Add as `releaseDate` property on `Release`. |
| `notes`                              | Free-text string                 | Store as `notes` property on `Release` — contains pressing info, variants.                            |
| `identifiers[]`                      | Barcode, matrix/runout           | Consider storing barcode as `barcode` on `Release` for deduplication.                                 |
| `videos[]`                           | YouTube links per release        | Could enrich a future frontend — skip for now                                                         |
| `community.rating`                   | `{ count, average }`             | Interesting for ranking queries — store as `communityRating` and `communityRatingCount` on `Release`. |
| `thumb`                              | 150px thumbnail URL              | Redundant with `images[].uri150` on the primary image — skip top-level `thumb`                        |
| `uri`                                | Discogs web URL                  | Store as `discogsUrl` on `Release` — useful for linking back                                          |
| `master_url`                         | Discogs API URL for master       | Skip — derivable from `master_id`                                                                     |
| `blocked_from_sale` / `is_offensive` | boolean flags                    | Skip                                                                                                  |
| `estimated_weight`                   | grams                            | Skip                                                                                                  |

---

## 5. Schema Recommendations

### New properties to add to `Release` node

```
releaseDate: string    // ISO date from `released` field (e.g. "2019-05-03")
notes: string          // optional, free-text from `notes` field
discogsUrl: string     // from `uri` field
communityRating: float // from `community.rating.average`
communityRatingCount: int // from `community.rating.count`
barcode: string        // from `identifiers` where type === "Barcode"
```

### `tracklist[].type_` — add filter at ingestion

Filter `tracklist` entries by `type_ === "track"` before creating Track nodes. Otherwise heading entries (e.g. "Side A") become phantom Track nodes.

### `duration` — treat as optional

`duration` on Track is frequently `""` (empty string). Store as nullable; don't block ingestion on absence.

### Studio capture — expand filter

In addition to `entity_type_name === "Recorded At"`, also capture `"Mixed At"` for Studio nodes. These often refer to the same studio and are equally useful for relationship traversal. Filter by entity_type numeric code (23 = Recorded At, 27 = Mixed At) for reliability.

### Musician role parsing

`extraartists[].role` is a comma-delimited multi-value string, not a single value. For the `CREDITED_ON` relationship:

- Store raw `role` string as-is
- Add a `displayRole` property that splits on `, ` and takes the first token
- Do not try to normalize all instrument variants at schema time — too much variance

### Handle `id === 0` on extraartists

Skip `discogsId` assignment for extraartists with `id === 0`. Create a name-only stub node if needed, or skip entirely. These are acknowledgments, not proper Discogs artist entries.

### `anv` (artist name variation)

Store `anv` on the relationship (e.g., `CREDITED_ON`, `RELEASED_BY`) as `creditedAs` when non-empty. This preserves the sleeve credit without corrupting the canonical artist name.

### `CREDITED_ON` — Track vs Release level

The API provides credits at two levels:

- `release.extraartists[]` — album-wide credits (producer, engineer, designer)
- `release.tracklist[n].extraartists[]` — track-level credits (who played what on each song)

Recommend two parallel relationship types (or a `scope` property):

- Album-level credits → `Musician -[:CREDITED_ON {scope: "release"}]-> Release`
- Track-level credits → `Musician -[:CREDITED_ON {scope: "track"}]-> Track`

This is where the richest musician-traversal data lives.

---

## 6. Rate Limiting — Observed Behavior

- 2 requests made (collection + full release) with 1000ms delay — no rate limit hit.
- Auth header `Authorization: Discogs token={TOKEN}` is correct — no `401` errors.
- The spec's 60 req/min limit appears accurate. At 1000ms delay the pipeline makes 1 request/second = 60 req/min, which sits at the authenticated limit. For a 200-release collection: ~40 paginated collection pages + 200 full release fetches ≈ 240 total requests ≈ 4 minutes of ingestion time. The default 1000ms delay is safe in practice since requests are sequential and rarely perfectly spaced at 1/second.
- No `429` responses observed. Exponential backoff still recommended as a safeguard.

---

## 7. Summary

**Good news:** All spec fields are present. The API returns richer data than expected — per-track musician credits are a particularly valuable graph edge source.

**Adjustments needed before Task 3:**

1. `duration` is frequently empty — treat as nullable on Track node
2. `formats[].qty` is a string — parse to int at ingestion
3. `tracklist[].type_` — filter to `"track"` type only; skip headings
4. `role` field is comma-delimited multi-instrument string — store raw, parse a primary role
5. `extraartists` with `id === 0` — handle gracefully (no discogsId, name-only or skip)
6. Studio filter: capture `entity_type_name` values "Recorded At" AND "Mixed At" for Studio nodes
7. Add `releaseDate`, `notes`, `discogsUrl`, `communityRating`, `barcode` to Release node properties
8. Consider `CREDITED_ON` at Track level (not just Release level) — this is the richest data
9. `anv` → store as `creditedAs` on relationships

**No blockers to schema implementation.** The spec's core graph model is valid. Proceed with Task 3 with the adjustments noted above.
