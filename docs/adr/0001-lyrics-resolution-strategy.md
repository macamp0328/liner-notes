---
status: accepted
---

# Lyrics resolution: a five-state, confidence-gated model, not a single null

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
low-confidence, not-found}` and resolve in a fixed priority order:

1. **LRCLIB `instrumental` flag** (authoritative) → `instrumental`, terminal.
2. **LRCLIB plain lyrics** → confidence-gated (see below): `resolved` (source `lrclib`) or
   `low-confidence`.
3. **AcousticBrainz `voiceInstrumental == 'instrumental'`** (the value we already store) →
   `probable-instrumental`, terminal but lower-certainty.
4. **Genius** fallback (when `GENIUS_TOKEN` is set) → confidence-gated: `resolved` (source
   `genius`) or `low-confidence`.
5. otherwise → `not-found`.

Both instrumental classifications are **terminal and short-circuit before Genius** — they
are excluded from the candidate query, so they are never re-attempted. This removes the
bulk of the wasted Genius calls and 403 spam at the source. `not-found` and `low-confidence`
stay candidates, throttled to one retry per staleness window. `/stats` reports coverage over
the _non-instrumental_ denominator (`total − instrumental − probable-instrumental`) plus the
full `resolved / instrumental / probable-instrumental / low-confidence / not-found` funnel.

**Match confidence (#248).** Steps 2 and 4 do not store lyrics blindly. Each source echoes
the title/artist (and, for LRCLIB, the duration) it matched on; `scoreLyricsMatch`
(`src/enrichment/match-confidence.ts`) scores it as
`confidence = min(titleSim, artistSim) × (duration disagrees ? 0.5 : 1)`, reusing the same
Sørensen–Dice similarity + duration tolerance as the MusicBrainz track matcher. An absent
axis or unknown duration scores 1.0 (absence is not evidence against — without this, Genius,
which never carries a duration, would be gutted). At or above `LYRICS_CONFIDENCE_THRESHOLD`
(env, default 0.85) the match is `resolved` with `lyricsConfidence` +
`lyricsMatchedTitle`/`lyricsMatchedArtist` provenance; below it the lyric text is **dropped**
and the track is `low-confidence` (provenance + score still stored). This is what stops the
#31 wrong-song corruption (artist matched, wrong song) and the live/remix duration-mismatch
class. The `GeniusClient` additionally rejects obvious title mismatches before the page
scrape (a strict subset of this gate). Cross-source LRCLIB↔Genius _agreement_ (the issue's
signal #3) is left as a follow-up: the short-circuit flow never fetches both for one track.

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

- **`low-confidence` is non-terminal and stays in the coverage denominator.** A rejected
  match means "found something, didn't trust it" — unlike the terminal instrumental classes,
  a better catalog match or a retuned threshold can later upgrade it, so it stays a candidate
  (throttled per staleness window) and stays in the honest non-instrumental denominator (a
  track that _could_ have lyrics, like `not-found`). The lyric text is not stored, so coverage
  keys on `lyrics IS NOT NULL` still exclude it; only the score + provenance persist.

- **`clearGeniusLyrics` resets `lyricsStatus`** and the confidence/provenance fields along
  with the lyrics it nulls, so a cleared track can't keep a stale `resolved` status or stale
  match metadata with no lyrics. The per-source `/stats` split gates on `lyrics IS NOT NULL`
  so a `low-confidence` track's `lyricsSource` (kept for provenance) doesn't inflate coverage.

- **No index on `lyricsStatus`.** The candidate query already scans the bounded
  `(:Release)-[:HAS_TRACK]->(:Track)` set; the status is a low-cardinality post-filter.
  Matches the existing no-index-on-`lyrics` choice.

- **LRCLIB's `duration` is now consumed** by the confidence gate (#248) as the
  length-based check anticipated here — the client parses it from the 200 response, but it is
  used transiently for scoring and is not persisted on the Track.

- **Existing rows are not re-scored in place.** A stored lyric never kept its matched
  provenance/duration, so re-evaluating it requires re-fetching from the source — exactly what
  `clear-genius` + `pnpm lyrics:enrich:local` (and a full reload) already do. The gate runs on
  every fresh resolution, so a pre-launch full data refresh re-classifies the historical rows;
  no separate in-place migration is provided.
