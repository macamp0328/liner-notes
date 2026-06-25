---
status: accepted
---

# Enrichment candidate selection: terminal-empty vs throttled-recheck

## Context

Every external-source enrichment answers a per-item question — does LRCLIB have lyrics for this
track, does Discogs list members for this musician, does MusicBrainz have a Work for this recording?
A "no" can mean two genuinely different things:

1. **Throttled-recheck** — no data _right now_, but it could appear later (upstream coverage grows,
   a dependency fills in). Re-check it, but not every run — once per staleness window.
2. **Terminal-empty** — no data, _ever_. The absence is permanent: a confirmed non-group has no
   members, an instrumental has no lyrics, group-ness and instrumental-ness are immutable. Stop
   looking forever.

The staleness throttle (`<source>FetchedAt`, #89) modelled state 1 universally. State 2 existed in
only two places, ad-hoc and inconsistent: `lyrics` (a `lyricsStatus` enum where
`instrumental`/`probable-instrumental` are excluded from the candidate query, ADR 0001) and
`group-members` (a `notAGroup` boolean). Every other source re-attempted permanently-empty data
forever — throttled, but never stopped. Worse, the shapes disagreed (an enum vs a boolean) with no
shared abstraction, and `group-members` _already_ wrote its permanent `notAGroup` marker on every
no-members result yet the runner still counted those ~2.9k confirmed non-groups as `skipped`
(throttle) — mislabeling permanent state as transient.

This is the missing complement to the work #377/#371 did on the _transient_ axis. That hardening
ensured a 5xx blip under reload contention is counted `failed` (retry next run), **not** mistaken
for missing data ("AcousticBrainz is frozen/read-only, so a 5xx is always a blip, never a real
'gone'"). So the `EnrichmentStage`/`runEnrichment` contract already separated **transient** (throw →
`failed` → retry) from **empty** (`null` → `skipped` → throttle). What it lacked was the third leg:
**permanent-empty** (terminal → never re-check). `resolve()` returning `null` collapsed both empty
states into one.

## Decision

Split `null` into a third, explicit `resolve()` outcome in the runner contract
([`src/enrichment/run.ts`](../../services/graph-service/src/enrichment/run.ts)).

1. **A `TERMINAL_EMPTY` sentinel.** `resolve()` returns `TResolved | null | typeof TERMINAL_EMPTY`.
   It is a unique `Symbol`, so it can never collide with a stage's `TResolved` payload (which may
   itself be an object or union, as lyrics' is).

2. **A new `markTerminal` handler and an `exhausted` counter.** On `TERMINAL_EMPTY` the runner calls
   `stage.markTerminal` — which writes a **permanent** marker (plus the `*FetchedAt` stamp) — and
   increments `exhausted`, a fifth `EnrichmentSummary` field distinct from `skipped`. `skipped`
   stays "throttled, re-checked next window"; `exhausted` is "terminal, never re-checked".

3. **`markAttempted` and `markTerminal` are both optional — declare only the outcomes you produce.**
   A stage whose `resolve` only ever returns data-or-terminal (like `group-members`) omits
   `markAttempted`; one that only throttles omits `markTerminal`. Returning an outcome whose handler
   is absent is a contract bug, so the runner **throws** it into the per-item `failed` path (loud,
   isolated, retried next run) rather than silently degrading. A silent fallback from terminal to
   the throttle stamp would re-query permanent data forever — the #240-class waste this whole effort
   exists to kill.

4. **Candidate queries exclude the terminal marker with a null-safe boolean `<marker> IS NULL`
   gate** — the default. This sidesteps the trap lyrics needed `coalesce(t.lyricsStatus, '')` for:
   `NOT (null IN [...])` evaluates to `null`, silently dropping every never-classified row. A
   boolean `IS NULL` gate is inherently null-safe.

5. **Terminal is opt-in per value; throttle-only is the default.** Some absences are permanent;
   most are just coverage that hasn't caught up. The per-source audit below records which is which —
   the audit decisions are part of the design, not a mechanical rollout.

6. **Marker property names are per-stage, not standardized.** `group-members` keeps `notAGroup`
   (semantic, and renaming a live property needs a graph migration for no gain); a new terminal
   source would add its own boolean (e.g. `<source>Exhausted`). The contract uniformity is the
   _outcome_ (`TERMINAL_EMPTY` → `markTerminal` → `exhausted`), not the property name.

7. **Lyrics keeps its `lyricsStatus` enum; it is the rich-domain exemplar, not a consumer of the
   generic boolean.** The enum carries information a boolean throws away — a 5-state `/stats` funnel
   (resolved/instrumental/probable-instrumental/low-confidence/not-found) and two _distinct_
   terminal certainties — and its instrumental classifications flow through `write`/`enriched` by
   deliberate ADR 0001 choice. Collapsing it onto a generic `exhausted` boolean would regress the
   funnel and reshuffle the coverage denominator for no functional gain. This is a deliberate
   deviation from the issue's literal "lyrics + group-members converge" wording: lyrics _already_
   implements two-state, more richly than the generic mechanism, so it adopts the shared concept
   without adopting the boolean.

8. **`group-members` converges onto the mechanism** — the canonical demonstration. Its
   `stampMembersFetched` (which always set both `membersFetchedAt` and `notAGroup`) is renamed
   `markNotAGroup` and wired to `markTerminal`; `resolve` returns `TERMINAL_EMPTY` for a no-members
   musician; it omits `markAttempted` (there is no throttled-recheck path — group-ness is
   immutable). Its candidate gate (`notAGroup IS NULL`) and reset (`resetGroupMembers`, which clears
   both markers) were already correct.

### Per-source audit

| Source                 | Verdict                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lyrics`               | **Terminal (enum exemplar)**       | `instrumental`/`probable-instrumental` are terminal via the richer `lyricsStatus` enum (ADR 0001). Not converged onto the generic boolean — see Decision 7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `group-members`        | **Terminal (converged)**           | A no-members result is permanent (group-ness is immutable). The reference convergence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `master-data`          | Throttle-only                      | The candidate query already filters `r.masterDiscogsId IS NOT NULL`, so a release with no master is **never a candidate** — there is no terminal row to mark. A master with no year yet can gain one (throttle).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `track-musicbrainz`    | Throttle-only                      | MusicBrainz coverage grows; an unmatched track today can match later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `track-works` (#379)   | Throttle-only                      | A recording with no MusicBrainz Work is coverage that grows, not a permanent absence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `track-deezer`         | Throttle-only                      | "No data" depends on `isrc` (a dependency, not terminal) and Deezer's catalog grows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `nationality`          | Throttle-only                      | Coverage grows; even `id===0` musicians may match by name later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `artist-profiles`      | Throttle-only                      | A Discogs profile can be added later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mb-release-events`    | **Throttle-only (resolved, #385)** | A missing Discogs↔MB release-group link is **not** permanent: MusicBrainz is a living DB whose editors add the crosswalk over time (coverage grows), exactly like `track-musicbrainz`/`track-works`/`nationality` — unlike an immutable non-group or the frozen AcousticBrainz. A terminal marker would forever skip a Master MB later links (a silent, non-self-healing regression), while the only cost of staying throttle is one MB call per no-link master per window. Re-audited per #385: no `exhausted` outcome is produced, so the no-op warning's `skipped` reading and `mastersSkipped` keep their throttle meaning, unchanged. The no-link population (the set a marker would have frozen) is now observable via the ungated `/stats.mastersWithMbReleaseGroup` metric. |
| `track-acousticbrainz` | **Terminal (batch-local, #384)**   | The **strongest** terminal case — AcousticBrainz is frozen/read-only (reconfirmed by #377), so a recording absent from a successful bulk response is permanent. Implemented via an `acousticBrainzExhausted` boolean + `IS NULL` gate **outside** the runner contract, since it is an off-contract **batch** stage with no `resolve`; see below.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Consequences

- **The `exhausted` field ripples to `EnrichmentSummary` and every empty-summary literal**
  (`ingest.ts`, plus the route/ingest test fixtures), found mechanically by `pnpm typecheck`.
  Existing tests that assert summary shape with `toMatchObject` (a subset match) survive untouched;
  only the `toEqual` fixtures and the one exact progress-line string assertion needed editing. The
  custom-summary stages (`track-musicbrainz`, `track-works`, `mb-release-events`, `nationality`)
  declare their own counters and are throttle-only, so `exhausted` is always 0 there — no change.

- **The reload verify coverage gate is unaffected.** It reads graph coverage via `/stats`, not
  per-run summary counters, so reclassifying group-members' non-groups from `skipped` to `exhausted`
  cannot break it. No change to `reload-verify.ts`.

- **`exhausted` surfaces in both status surfaces.** `/admin/reload/status` carries it for free (its
  `counts` schema allows additional numeric properties); `/admin/<stage>/status` needed
  `exhausted` added to `standardSummarySchema` or Fastify's response serializer would strip it.

- **group-members' ~2.9k confirmed non-groups move from `skipped` to `exhausted`.** This is a
  reporting correctness fix, not a behavior change — they were already terminal via `notAGroup` and
  already excluded from the candidate query; only the counter they landed in was wrong.

- **No new index, no backfill.** The terminal gate is a low-cardinality post-filter on an
  already-bounded candidate scan — matching the no-index-on-`lyricsStatus` choice (ADR 0001). And
  `notAGroup` has been live since #366, so no data migration is required.

- **Reset routes must clear the terminal marker.** `resetGroupMembers` already clears both
  `membersFetchedAt` and `notAGroup`. Any future terminal source's reset must clear its marker too,
  or a reset will not re-sweep the terminal rows.

- **Two follow-ups, both now resolved.** `track-acousticbrainz` — the strongest terminal case but an
  off-contract batch stage (no `resolve`) — was implemented in **#384** via a batch-local
  `acousticBrainzExhausted` boolean + `IS NULL` gate written _outside_ the runner contract. Because
  the source is frozen, every confirmed non-match (absent from a successful bulk response, or
  present-but-all-null) is terminal, so the stage has no throttled-recheck path: its `tracksSkipped`
  counter is now always 0 and the old `*Skipped` bucket moved wholesale to `tracksExhausted`. The
  breaker-open path had to stop collapsing into an empty map (it now throws → `failed`), or a
  transient blip would have permanently exhausted every in-flight track. `mb-release-events` was
  evaluated in **#385** and deliberately **kept throttle-only**: its no-link absence is transient (a
  living-DB crosswalk that grows), not the immutable/frozen-source absence that earns a terminal
  marker, so no `TERMINAL_EMPTY` outcome is introduced and the no-op warning's `skipped` reading +
  `MbReleaseEventsEnrichmentSummary.mastersSkipped` keep their throttle semantics unchanged. The
  no-link population a marker would have frozen is now surfaced as the ungated
  `/stats.mastersWithMbReleaseGroup` coverage metric, making the "coverage grows" rationale observable
  rather than asserted.
