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
  type UnenrichedTrack,
} from '../db/lyrics-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';

export type LyricsEnrichmentSummary = EnrichmentSummary;

/** What a successful lyrics lookup resolves to: the text and the source that provided it. */
interface LyricsResolved {
  lyrics: string;
  source: 'lrclib' | 'genius';
}

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
 * Enrich all Track nodes that lack lyrics. Queries LRCLIB first (primary); falls back to Genius
 * only when a client is configured (`GENIUS_TOKEN` set). Missing lyrics are logged and skipped —
 * never crashes the caller.
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
      if (lrclibResult !== null) return { lyrics: lrclibResult, source: 'lrclib' };

      // LRCLIB returned null (404 / no plainLyrics) — try Genius fallback when configured.
      if (!genius) {
        log.debug?.('[lyrics] Genius client not configured — skipping Genius fallback');
        return null;
      }
      const geniusResult = await genius.getLyrics(track.artistName ?? '', track.title);
      return geniusResult === null ? null : { lyrics: geniusResult, source: 'genius' };
    },
    write: (d, track, resolved) =>
      setTrackLyrics(d, track.releaseDiscogsId, track.position, resolved.lyrics, resolved.source),
    markAttempted: (d, track) => markLyricsFetched(d, track.releaseDiscogsId, track.position),
    isExpectedError: isExpectedGeniusBlock,
    describeItem: (track) => `"${track.title}"`,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress, concurrency });
}
