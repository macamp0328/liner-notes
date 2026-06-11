---
status: accepted
---

# Lyrics resolution: a four-state model, not a single null

## Context

A `Track.lyrics` of `NULL` used to mean four different things at once: lyrics we
resolved, lyrics that don't exist (instrumentals), lyrics that exist but we missed, and
lyrics we never tried. Conflating them was actively harmful — every instrumental looked
like a miss, so the pipeline fired a doomed Genius search + page scrape at it (in prod a
403 → error log → CloudWatch alarm, #240/#243) and, because the only marker was a
`lyricsFetchedAt` timestamp, retried it every staleness window forever. Coverage was also
understated: `/stats` divided resolved lyrics by _all_ tracks, including instrumentals
that can never have lyrics.

## Decision

Track an explicit `lyricsStatus ∈ {resolved, instrumental, probable-instrumental,
not-found}` and resolve in a fixed priority order:

1. **LRCLIB `instrumental` flag** (authoritative) → `instrumental`, terminal.
2. **LRCLIB plain lyrics** → `resolved` (source `lrclib`).
3. **AcousticBrainz `voiceInstrumental == 'instrumental'`** (the value we already store) →
   `probable-instrumental`, terminal but lower-certainty.
4. **Genius** fallback (when `GENIUS_TOKEN` is set) → `resolved` (source `genius`).
5. otherwise → `not-found`.

Both instrumental classifications are **terminal and short-circuit before Genius** — they
are excluded from the candidate query, so they are never re-attempted. This removes the
bulk of the wasted Genius calls and 403 spam at the source. `not-found` stays a candidate,
throttled to one retry per staleness window. `/stats` reports coverage over the
_non-instrumental_ denominator (`total − instrumental − probable-instrumental`) plus the
full `resolved / instrumental / probable-instrumental / not-found` funnel.

This is the design anchor the sibling confirmation issue (which adds a `low-confidence`
state) and the concurrency issue build on.

## Consequences

- **`resolved`/coverage keys on `lyrics IS NOT NULL`, not `lyricsStatus = 'resolved'`.**
  Tracks enriched before this field existed have a null status; keying on the status would
  mislabel every one of them `not-found`. A guarded, idempotent backfill in `schema.ts`
  sets `lyricsStatus = 'resolved'` on existing lyric'd tracks, but keying coverage on the
  ground-truth property makes the funnel correct even before it runs.

- **`probable-instrumental` rarely fires on the primary reload.** `voiceInstrumental` is
  produced by the `track-acousticbrainz` stage, which depends on the slow
  `track-musicbrainz` stage and finishes long after `lyrics` in a fresh reload. So the
  signal mostly takes effect on a later staleness re-run. We deliberately do **not** make
  `lyrics` depend on `track-acousticbrainz` — that would chain it behind the ~2.5hr
  MusicBrainz stage and defeat the early-lane scheduling (#176). A `not-found` track stays
  re-eligible, so the later run upgrades it.

- **Instrumental classifications count as `enriched` in the per-stage run summary.** They
  flow through the `EnrichmentStage.write` path; adding a fourth outcome to that contract
  would touch all six stages that share it. They _are_ a successful terminal
  classification, the reload verify gate reads `/stats` coverage rather than the run
  summary, and the meaningful funnel lives in `/stats` — so this is accepted, not papered
  over.

- **`clearGeniusLyrics` resets `lyricsStatus`** along with the lyrics it nulls, so a
  cleared track can't keep a stale `resolved` status with no lyrics.

- **No index on `lyricsStatus`.** The candidate query already scans the bounded
  `(:Release)-[:HAS_TRACK]->(:Track)` set; the status is a low-cardinality post-filter.
  Matches the existing no-index-on-`lyrics` choice.

- **LRCLIB's `duration` is not stored.** The richer LRCLIB result carries it, but nothing
  consumes it yet; add it when a use exists (e.g. a length-based confidence check).
