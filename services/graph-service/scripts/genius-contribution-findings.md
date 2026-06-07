# Genius incremental lyric contribution over LRCLIB — measurement (#241)

**TL;DR.** Of the **577** tracks with `t.lyrics IS NULL`, Genius would add **0 valid lyrics today** (`GENIUS-WIN = 0 / 577`). That zero is **not** because Genius lacks the lyrics — it's two stacked bugs: a Cloudflare-blocked production egress **and** a header-strip bug in our extractor. If **both** were fixed, the ceiling is **~105 / 577 (≈18%)** of pages that would pass our validator, of which **~87 (≈15%)** are genuine, correct lyrics. The remaining ~469 candidates (≈81%) have no retrievable lyrics from Genius regardless of any fix.

This closes the acceptance gap from [#195](https://github.com/macamp0328/liner-notes/issues/195) ("Genius's real lyric contribution is a known number, not an inference") and is the deciding input for [#240](https://github.com/macamp0328/liner-notes/issues/240).

## Method

Run with [`genius-contribution-probe.ts`](genius-contribution-probe.ts) (this directory):

```bash
pnpm --filter graph-service exec tsx scripts/genius-contribution-probe.ts \
  --env /path/to/.env.local            # NEO4J_URI/USER/PASSWORD (prod)
```

- **Read-only.** Pulls the `t.lyrics IS NULL` candidate set from Neo4j and never writes (no MERGE/SET). Artist is the first `RELEASED_BY` artist — identical to production's `getUnenrichedTracks`.
- **Exact production logic.** Each candidate runs the production LRCLIB→Genius fallback. Genius pages are scored with the _same_ extractor/validator production uses, imported from [`src/enrichment/lyrics-extract.ts`](../src/enrichment/lyrics-extract.ts) — no copy-paste drift.
- **Residential egress.** Genius is hit via its unauthenticated public search (`genius.com/api/search/song`) — same song results + URLs as the token'd API, so no `GENIUS_TOKEN`. **It must run from a home IP:** the prod EC2 egress gets a Cloudflare `403`; a residential IP gets `200`. This is the whole reason prod's measured contribution is `0` ([#195](https://github.com/macamp0328/liner-notes/issues/195)).
- Ran three full passes (2026-06-06). The decision-relevant numbers are stable across all three.

## Results (577 candidates)

| outcome               | count |     % | meaning                                                     |
| --------------------- | ----: | ----: | ----------------------------------------------------------- |
| `GENIUS-WIN`          | **0** |  0.0% | valid lyrics Genius would add over LRCLIB                   |
| `LRCLIB-NOW-HITS`     |     0 |  0.0% | LRCLIB now covers it (coverage drift) — none                |
| `no-song-hit`         |   317 | 54.9% | search found no matching song                               |
| `artist-mismatch`     |    39 |  6.8% | found a song, wrong artist                                  |
| `no-lyrics-container` |   113 | 19.6% | right page, no lyric block (instrumental / not transcribed) |
| `invalid-lyrics`      |   108 | 18.7% | page has a lyric block, but our validator rejects it        |
| `error`               |     0 |  0.0% | network/HTTP failure after retries                          |

`no-song-hit`/`artist-mismatch` wobble by a few across runs (live search is non-deterministic at the margin: 321/35 vs 317/39); `no-lyrics-container` (113), `invalid-lyrics` (108), and `GENIUS-WIN` (**0**) are identical every run.

So **~469 / 577 (≈81%)** of the misses are tracks with **no retrievable Genius lyrics at all** — the "577 missing lyrics" figure was never 577 lyrics we could get. This matches the issue's hypothesis: the misses are dominated by instrumentals, deep cuts, and non-English/obscure tracks Genius doesn't have.

## The `invalid-lyrics` 108 — the "hidden upside"

Every one of the 108 fails on the **same** validator rule (`isValidGeniusLyrics`'s `^\d+\s+Contributor` guard, added in [#31](https://github.com/macamp0328/liner-notes/issues/31) to reject Genius header junk). The extractor leaves Genius's `"<N> Contributors<Title> Lyrics"` header on the front of the body, so the validator rejects the whole thing — even though real lyrics follow the header. Example (header bolded):

> **2 ContributorsRight On Time Lyrics**Well, well, yeah Right on time, right on time…

Stripping that header and re-validating (the probe does this inline, no extra fetch):

|                                                       |         count | notes                                                                     |
| ----------------------------------------------------- | ------------: | ------------------------------------------------------------------------- |
| **recoverable** (passes validator after header strip) | **105 / 108** | what production _would store_ if the extractor were fixed                 |
| not recoverable                                       |             3 | `"Instrumental"`, `[Humming]`, `[Non-Lyrical Vocals]` — genuine no-lyrics |

Of the 105 recoverable, a closer read of the bodies (heuristic on a 90-char head, so ±a couple):

- **~87 genuine, correct lyrics** — real song lyrics for the right track, mangled only by the header.
- **14 editorial "About" descriptions** — Genius shows an annotation in the lyric container (mostly for instrumentals: Beck "Cycle"/"Phase", Childish Gambino "The Night Me and Your Mama Met", several Freddie Gibbs _Piñata_ tracks, James Taylor "Mexico"/"Steamroller"). These would pass the validator and be stored as "lyrics" but aren't lyrics — our validator can't tell prose from lyrics, so this is a **data-quality caveat**, not extra signal.
- **~4 wrong-song matches** — artist matched but the search resolved to a different track (Stephen Stills "Stop"→"Love Story", Johnny Guitar Watson "Guitar Disco"→"Gangster of Love", Birdlegs & Pauline "Pauline"→"Mist Of A Dream", Cymande "Zion I"→"Road to Zion"). Real lyrics, wrong song.

So the **true content gain** ceiling is **~87 / 577 (≈15%)**; the **stored** ceiling (what the pipeline would actually write, including the ~18 description/wrong-song false positives the validator can't catch) is **105 / 577 (≈18%)**.

## What this means for #240

The headline "0" is produced by **two independent gates**, and clearing either one alone still yields ~0:

1. **Egress** — prod's datacenter IP is Cloudflare-blocked. Fixing only this (a proxy / residential egress, the [#240](https://github.com/macamp0328/liner-notes/issues/240) "proxy" option) still returns **0**, because…
2. **Extractor header bug** — the unstripped `"<N> Contributors… Lyrics"` header makes the validator reject all 108. Fixing only this (the sibling extractor issue) still returns **0** in prod, because the egress is blocked.

**Fix both → ~87 genuine lyrics (~15%) recovered** (~105 stored).

This is **not** the "trivial gain → neutralize and forget" outcome the issue floated as likely. Concretely:

- The **extractor header-strip fix is cheap, in-repo, and clearly worth doing** (it's the sibling issue, and it's the larger of the two levers — it accounts for the entire 0→105). Worth doing on its own merits regardless of #240.
- The **egress is the gating cost.** ~87 lyrics in exchange for standing up a non-blocked egress (proxy) is a real, non-trivial trade — a judgment call for the operator, but the gain is large enough that "don't chase lyrics" is no longer the obvious call. If the egress is deemed not worth it, the honest move is to **neutralize the Genius fallback in prod** (it contributes 0 there today and just burns 429/403 retries), while still landing the extractor fix so a future egress decision can flip it on.

## Caveats / reproducibility

- The probe checkpoints to a JSONL file in the OS temp dir (resumable) and is **not** committed — it holds redacted ~60/90-char heads for the real-vs-junk triage above, never full lyric text (copyright). This doc reports only aggregates and `(artist, title, outcome)` tuples.
- The recoverable/description/wrong-song split is computed from short redacted heads; the headline (`GENIUS-WIN = 0`, `recoverable = 105/108`) is exact, the ~87/~14/~4 sub-split is ±a couple.
- Re-run any time with the command above; the candidate set tracks the live graph, so the absolute count moves as the collection/LRCLIB coverage changes.
