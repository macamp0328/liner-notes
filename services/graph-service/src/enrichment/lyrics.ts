import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { LrclibClient, buildLrclibClientFromEnv } from '../ingestion/lrclib-client.js';
import {
  GeniusClient,
  buildGeniusClientFromEnv,
  isExpectedGeniusBlock,
} from '../ingestion/genius-client.js';
import {
  getUnenrichedTracks,
  setTrackLyrics,
  markLyricsFetched,
  markTrackInstrumental,
  markTrackProbableInstrumental,
  type UnenrichedTrack,
} from '../db/lyrics-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import { closedSnapshot } from '../ingestion/circuit-breaker.js';

/**
 * The lyrics summary plus the per-run circuit-breaker outcome for each source (#242). The four
 * breaker fields are numeric so they flow through the lyrics stage's `counts` into
 * `/admin/reload/status` — Genius/LRCLIB are not `ctx`-level clients, so they surface here rather
 * than via the orchestrator's source fold.
 */
export interface LyricsEnrichmentSummary extends EnrichmentSummary {
  geniusFatalCount: number;
  /** 1 when the Genius breaker tripped this run, else 0. */
  geniusBreakerOpen: number;
  lrclibFatalCount: number;
  /** 1 when the LRCLIB breaker tripped this run, else 0. */
  lrclibBreakerOpen: number;
}

/**
 * A terminal classification of a track's lyrics (issue #246). `resolve` returns one of these
 * or `null` (= not-found, retry per staleness):
 * - `resolved` — lyrics found, with the source that provided them.
 * - `instrumental` — LRCLIB's authoritative `instrumental` flag; no lyrics exist.
 * - `probable-instrumental` — LRCLIB has no record, but the AcousticBrainz `voiceInstrumental`
 *   we already store classifies the track instrumental. Lower certainty than `instrumental`.
 *
 * All three flow through `write` (the runner counts them `enriched`); only `null` reaches
 * `markAttempted`. The two instrumental kinds are terminal — excluded from candidate retries.
 */
type LyricsResolved =
  | { kind: 'resolved'; lyrics: string; source: 'lrclib' | 'genius' }
  | { kind: 'instrumental' }
  | { kind: 'probable-instrumental' };

/**
 * Injectable clients — defaults are built from the environment. The seam exists so unit tests
 * can pass zero-backoff clients, and so the circuit breaker (#242) can wrap them without
 * touching this orchestration code.
 */
export interface LyricsClients {
  lrclib?: LrclibClient;
  genius?: GeniusClient | null;
}

const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 12;

/**
 * Resolve `LYRICS_CONCURRENCY` (env) to a sane worker count. Bounded concurrency is the lyrics
 * stage's rate ceiling (#247) — it has no separate limiter. Non-numeric/unset → default; values
 * are clamped to `[1, MAX_CONCURRENCY]` so a fat-fingered env var can't hammer LRCLIB.
 */
function resolveConcurrency(): number {
  const parsed = parseInt(process.env['LYRICS_CONCURRENCY'] ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
  return Math.min(Math.max(parsed, 1), MAX_CONCURRENCY);
}

/**
 * Enrich all Track nodes that lack lyrics.
 * Resolution order (issue #246): LRCLIB's instrumental flag → LRCLIB lyrics → the stored
 * AcousticBrainz `voiceInstrumental` signal → Genius fallback (when a client is configured) →
 * not-found. The two instrumental classifications are terminal and **short-circuit before
 * Genius**, which is where most of the wasted Genius-call / 403-spam savings come from
 * (#240/#243). Missing lyrics are logged and skipped — never crashes the caller.
 *
 * Stage-ordering caveat: `voiceInstrumental` is populated by the `track-acousticbrainz`
 * enrichment, which finishes long after `lyrics` in a fresh reload (it deps the slow
 * `track-musicbrainz` stage). So `probable-instrumental` rarely fires on the primary reload —
 * it classifies on the later staleness re-run. We deliberately do NOT make lyrics depend on
 * track-acousticbrainz (that would chain it behind the ~2.5hr stage and defeat #176's
 * early-lane design); a `not-found` track stays re-eligible to be upgraded later.
 *
 * The stage runs N-way concurrent (`LYRICS_CONCURRENCY`, default 6) — safe because each lyrics
 * write is one Track per transaction (deadlock-immune; see the #176 scheduler notes). The
 * multi-source fallback lives inside `resolve`, so a single track is only ever counted `failed`
 * once (LRCLIB throwing short-circuits the Genius attempt); the per-item loop, isolation, and
 * stamp-on-attempt contract are owned by {@link runEnrichment}.
 */
export async function enrichLyrics(
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
  clients?: LyricsClients,
): Promise<LyricsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const lrclib = clients?.lrclib ?? buildLrclibClientFromEnv(log);
  const genius = clients?.genius !== undefined ? clients.genius : buildGeniusClientFromEnv(log);
  const concurrency = resolveConcurrency();

  const stage: EnrichmentStage<UnenrichedTrack, LyricsResolved> = {
    name: 'lyrics',
    selectCandidates: (d) => getUnenrichedTracks(d),
    async resolve(track) {
      const lrclibResult = await lrclib.getLyrics(track.artistName ?? '', track.title);
      if (lrclibResult !== null) {
        // LRCLIB's authoritative instrumental flag — terminal, no Genius (#246).
        if (lrclibResult.instrumental) return { kind: 'instrumental' };
        if (lrclibResult.lyrics !== null)
          return { kind: 'resolved', lyrics: lrclibResult.lyrics, source: 'lrclib' };
      }

      // LRCLIB had no usable lyrics (404, or a record with no plain lyrics). Before spending a
      // Genius call, trust the AcousticBrainz signal we already store: a track classified
      // instrumental there is probably lyric-less, so short-circuit (most of the #240/#243 saving).
      if (track.voiceInstrumental === 'instrumental') return { kind: 'probable-instrumental' };

      // Try Genius fallback when configured.
      if (!genius) {
        log.debug?.('[lyrics] Genius client not configured — skipping Genius fallback');
        return null;
      }
      const geniusResult = await genius.getLyrics(track.artistName ?? '', track.title);
      return geniusResult === null
        ? null
        : { kind: 'resolved', lyrics: geniusResult, source: 'genius' };
    },
    write: (d, track, resolved) => {
      if (resolved.kind === 'resolved') {
        return setTrackLyrics(
          d,
          track.releaseDiscogsId,
          track.position,
          resolved.lyrics,
          resolved.source,
        );
      }
      if (resolved.kind === 'instrumental') {
        return markTrackInstrumental(d, track.releaseDiscogsId, track.position);
      }
      return markTrackProbableInstrumental(d, track.releaseDiscogsId, track.position);
    },
    markAttempted: (d, track) => markLyricsFetched(d, track.releaseDiscogsId, track.position),
    isExpectedError: isExpectedGeniusBlock,
    describeItem: (track) => `"${track.title}"`,
  };

  const base = await runEnrichment(driver, stage, { logger: log, onProgress, concurrency });

  // Surface each source's run-scoped breaker so a trip (e.g. Genius 403 all run, #240) is visible
  // in /admin/reload/status, not just the single warn line the breaker already logged.
  const geniusSnap = genius?.breakerSnapshot() ?? closedSnapshot('genius');
  const lrclibSnap = lrclib.breakerSnapshot();
  if (geniusSnap.open || lrclibSnap.open) {
    log.warn(
      `[lyrics] circuit breaker(s) tripped this run — genius open=${geniusSnap.open} fatals=${geniusSnap.fatalCount}, ` +
        `lrclib open=${lrclibSnap.open} fatals=${lrclibSnap.fatalCount}`,
    );
  }
  return {
    ...base,
    geniusFatalCount: geniusSnap.fatalCount,
    geniusBreakerOpen: geniusSnap.open ? 1 : 0,
    lrclibFatalCount: lrclibSnap.fatalCount,
    lrclibBreakerOpen: lrclibSnap.open ? 1 : 0,
  };
}
