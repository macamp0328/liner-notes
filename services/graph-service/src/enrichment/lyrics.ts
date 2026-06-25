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
  markTrackLowConfidence,
  type UnenrichedTrack,
} from '../db/lyrics-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import {
  runEnrichment,
  type EnrichmentStage,
  type EnrichmentSummary,
  type RetryConfig,
} from './run.js';
import { closedSnapshot } from '../ingestion/circuit-breaker.js';
import { transientNetworkCode } from '../ingestion/network-errors.js';
import { RetriesExhaustedError } from '../ingestion/rate-limited-fetch.js';
import {
  scoreLyricsMatch,
  isConfidentMatch,
  LYRICS_CONFIDENCE_DEFAULT,
  type LyricsMatchCandidate,
} from './match-confidence.js';

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
 * A classification of a track's lyrics (issues #246, #248). `resolve` returns one of these
 * or `null` (= not-found, retry per staleness):
 * - `resolved` — lyrics found AND the match cleared the confidence gate; carries the source, the
 *   confidence score, and the title/artist the source matched on (provenance).
 * - `low-confidence` — a source returned lyrics but the match-confidence gate rejected them (wrong
 *   song / wrong recording, #248). The lyric text is dropped; the score + provenance are stored so
 *   the doubt is visible. Non-terminal — stays a candidate.
 * - `instrumental` — LRCLIB's authoritative `instrumental` flag; no lyrics exist.
 * - `probable-instrumental` — LRCLIB has no record, but the AcousticBrainz `voiceInstrumental`
 *   we already store classifies the track instrumental. Lower certainty than `instrumental`.
 *
 * All flow through `write` (the runner counts them `enriched`); only `null` reaches
 * `markAttempted`. The two instrumental kinds are terminal — excluded from candidate retries.
 */
type LyricsResolved =
  | {
      kind: 'resolved';
      lyrics: string;
      source: 'lrclib' | 'genius';
      confidence: number;
      matchedTitle: string | null;
      matchedArtist: string | null;
    }
  | {
      kind: 'low-confidence';
      source: 'lrclib' | 'genius';
      confidence: number;
      matchedTitle: string | null;
      matchedArtist: string | null;
    }
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

/** Clamp a worker count to `[1, MAX_CONCURRENCY]` so a fat-fingered env var can't hammer LRCLIB. */
function clampConcurrency(value: number): number {
  return Math.min(Math.max(value, 1), MAX_CONCURRENCY);
}

/**
 * Resolve `LYRICS_CONCURRENCY` (env) to a sane worker count. Bounded concurrency is the lyrics
 * stage's rate ceiling (#247) — it has no separate limiter. Non-numeric/unset → default; values
 * are clamped to `[1, MAX_CONCURRENCY]`.
 */
function resolveConcurrency(): number {
  const parsed = parseInt(process.env['LYRICS_CONCURRENCY'] ?? '', 10);
  return Number.isFinite(parsed) ? clampConcurrency(parsed) : DEFAULT_CONCURRENCY;
}

/**
 * Resolve the lyrics worker count for a run inside the orchestrated reload (#372). Prefers
 * `RELOAD_LYRICS_CONCURRENCY` — a reload-only throttle for the heavy concurrent context, where
 * cross-stage DB/API contention inflates the transient-failure rate — and falls back to the normal
 * `resolveConcurrency()` (`LYRICS_CONCURRENCY` → default 6) when it is unset. Unset by default, so
 * the reload's lyrics concurrency is unchanged until an operator dials it down.
 */
export function resolveReloadLyricsConcurrency(): number {
  const parsed = parseInt(process.env['RELOAD_LYRICS_CONCURRENCY'] ?? '', 10);
  return Number.isFinite(parsed) ? clampConcurrency(parsed) : resolveConcurrency();
}

const DEFAULT_RETRY_ROUNDS = 2;

/**
 * Resolve `LYRICS_RETRY_ROUNDS` (env) — the bounded number of in-run transient-failure retry rounds
 * (#455). Default 2; `0` disables the sweep. Non-numeric/unset → default; a negative value clamps to
 * 0 (disabled), so a fat-fingered value fails safe rather than looping unboundedly.
 */
export function resolveLyricsRetryRounds(): number {
  const parsed = parseInt(process.env['LYRICS_RETRY_ROUNDS'] ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_RETRY_ROUNDS;
}

/**
 * Whether a thrown lyrics error is a transient blip worth re-attempting in the in-run retry sweep
 * (#455). True for a request timeout / undici socket error (`transientNetworkCode`) and for a
 * 429/5xx that exhausted the client's retry budget (`RetriesExhaustedError`) — the LRCLIB-timeout
 * failure mode the issue reported. Deliberately false for the plain `Error('LRCLIB API error <status>')`
 * non-ok path (a fatal-ish status) and for any Neo4j `write`-thrown error: a half-applied write must
 * not be blindly re-`resolve`d, and a non-transient failure won't change on a re-attempt.
 */
export function isRetryableLyricsError(err: unknown): boolean {
  return transientNetworkCode(err) !== null || err instanceof RetriesExhaustedError;
}

/**
 * Resolve `LYRICS_CONFIDENCE_THRESHOLD` (env) to the match-confidence gate (#248). Unset, empty,
 * non-numeric, or out of `[0, 1]` → fall back to {@link LYRICS_CONFIDENCE_DEFAULT} (0.85): a
 * fat-fingered value fails *safe* to the sensible default rather than silently accepting or
 * rejecting everything (`Number('')` is 0, which is why the empty-string guard is explicit).
 */
function resolveConfidenceThreshold(): number {
  const raw = process.env['LYRICS_CONFIDENCE_THRESHOLD'];
  if (raw === undefined || raw.trim() === '') return LYRICS_CONFIDENCE_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return LYRICS_CONFIDENCE_DEFAULT;
  return parsed;
}

/**
 * Score a candidate's matched title/artist/duration against the query track and gate it (#248):
 * a confident match becomes `resolved` (lyrics stored), below the gate becomes `low-confidence`
 * (lyrics dropped, score + provenance stored). Shared by the LRCLIB and Genius paths so both go
 * through one authoritative gate.
 */
function gradeMatch(
  track: UnenrichedTrack,
  source: 'lrclib' | 'genius',
  lyrics: string,
  candidate: LyricsMatchCandidate,
  threshold: number,
): LyricsResolved {
  const score = scoreLyricsMatch(
    { title: track.title, artist: track.artistName, durationSeconds: track.durationSeconds },
    candidate,
  );
  const provenance = {
    source,
    confidence: score.confidence,
    matchedTitle: candidate.matchedTitle,
    matchedArtist: candidate.matchedArtist,
  };
  return isConfidentMatch(score, threshold)
    ? { kind: 'resolved', lyrics, ...provenance }
    : { kind: 'low-confidence', ...provenance };
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
 * The stage runs N-way concurrent (`LYRICS_CONCURRENCY`, default 6, or `opts.concurrency` when a
 * caller overrides it — the orchestrated reload passes `RELOAD_LYRICS_CONCURRENCY`, #372) — safe
 * because each lyrics write is one Track per transaction (deadlock-immune; see the #176 scheduler
 * notes). The multi-source fallback lives inside `resolve`, so a single track is only ever counted
 * `failed` once (LRCLIB throwing short-circuits the Genius attempt); the per-item loop, isolation,
 * and stamp-on-attempt contract are owned by {@link runEnrichment}.
 *
 * The stage opts into the bounded in-run transient-failure retry sweep (#455, `LYRICS_RETRY_ROUNDS`,
 * default 2): after the main pass, transient failures (`isRetryableLyricsError`) are re-attempted with
 * an escalating jittered backoff so a fresh-reload LRCLIB blip — which has no later staleness window
 * in the same run — recovers before the stage completes instead of leaving a durable not-found gap.
 */
export async function enrichLyrics(
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
  clients?: LyricsClients,
  opts?: {
    concurrency?: number;
    /**
     * In-run transient-failure retry sweep overrides (#455). Production leaves these unset — rounds
     * come from `LYRICS_RETRY_ROUNDS` and the rest are sensible constants. Tests inject `sleep`
     * (a no-op) for determinism without fake timers, mirroring the zero-backoff-client pattern.
     */
    retry?: {
      maxRounds?: number;
      backoffBaseMs?: number;
      maxRetryableFraction?: number;
      sleep?: (ms: number) => Promise<void>;
      random?: () => number;
    };
  },
): Promise<LyricsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const lrclib = clients?.lrclib ?? buildLrclibClientFromEnv(log);
  const genius = clients?.genius !== undefined ? clients.genius : buildGeniusClientFromEnv(log);
  // Clamp the caller-supplied override too, not just the env resolvers — the `[1, 12]` ceiling is
  // the LRCLIB politeness budget, so an override must respect it regardless of who passes it.
  const concurrency =
    opts?.concurrency !== undefined ? clampConcurrency(opts.concurrency) : resolveConcurrency();
  const confidenceThreshold = resolveConfidenceThreshold();
  const retryRounds = opts?.retry?.maxRounds ?? resolveLyricsRetryRounds();

  const stage: EnrichmentStage<UnenrichedTrack, LyricsResolved> = {
    name: 'lyrics',
    selectCandidates: (d) => getUnenrichedTracks(d),
    async resolve(track) {
      const lrclibResult = await lrclib.getLyrics(track.artistName ?? '', track.title);
      if (lrclibResult !== null) {
        // LRCLIB's authoritative instrumental flag — terminal, no Genius (#246).
        if (lrclibResult.instrumental) return { kind: 'instrumental' };
        // LRCLIB matches title+artist closely, so its differentiator is the duration check (#248) —
        // a same-title live/remix with a divergent length is downgraded to low-confidence.
        if (lrclibResult.lyrics !== null)
          return gradeMatch(
            track,
            'lrclib',
            lrclibResult.lyrics,
            lrclibResult,
            confidenceThreshold,
          );
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
      const geniusResult = await genius.getLyrics(
        track.artistName ?? '',
        track.title,
        confidenceThreshold,
      );
      // Genius has no duration; its differentiator is the title-similarity gate (#248/#31). The
      // client already pre-filters obvious title mismatches; this is the authoritative re-score.
      return geniusResult === null
        ? null
        : gradeMatch(
            track,
            'genius',
            geniusResult.lyrics,
            {
              matchedTitle: geniusResult.matchedTitle,
              matchedArtist: geniusResult.matchedArtist,
              matchedDurationSeconds: null,
            },
            confidenceThreshold,
          );
    },
    write: (d, track, resolved) => {
      if (resolved.kind === 'resolved') {
        return setTrackLyrics(
          d,
          track.releaseDiscogsId,
          track.position,
          resolved.lyrics,
          resolved.source,
          resolved.confidence,
          resolved.matchedTitle,
          resolved.matchedArtist,
        );
      }
      if (resolved.kind === 'low-confidence') {
        return markTrackLowConfidence(
          d,
          track.releaseDiscogsId,
          track.position,
          resolved.source,
          resolved.confidence,
          resolved.matchedTitle,
          resolved.matchedArtist,
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

  // Opt into the bounded in-run retry sweep (#455) so a transient LRCLIB blip during a fresh reload
  // recovers in-run instead of hardening into a durable not-found gap. Omitted entirely when rounds
  // resolve to 0 (operator disabled), so the runner skips the sweep cleanly.
  const retry: RetryConfig | undefined =
    retryRounds > 0
      ? {
          maxRounds: retryRounds,
          isRetryable: isRetryableLyricsError,
          ...(opts?.retry?.backoffBaseMs !== undefined
            ? { backoffBaseMs: opts.retry.backoffBaseMs }
            : {}),
          ...(opts?.retry?.maxRetryableFraction !== undefined
            ? { maxRetryableFraction: opts.retry.maxRetryableFraction }
            : {}),
          ...(opts?.retry?.sleep !== undefined ? { sleep: opts.retry.sleep } : {}),
          ...(opts?.retry?.random !== undefined ? { random: opts.retry.random } : {}),
        }
      : undefined;

  const base = await runEnrichment(driver, stage, {
    logger: log,
    onProgress,
    concurrency,
    ...(retry !== undefined ? { retry } : {}),
  });

  // Surface each source's run-scoped breaker so a trip (e.g. Genius 403 all run, #240) is visible
  // in /admin/reload/status. The breaker already logs the trip once at warn, so we don't re-log
  // here — these persisted fields are the visibility channel.
  const geniusSnap = genius?.breakerSnapshot() ?? closedSnapshot('genius');
  const lrclibSnap = lrclib.breakerSnapshot();
  return {
    ...base,
    geniusFatalCount: geniusSnap.fatalCount,
    geniusBreakerOpen: geniusSnap.open ? 1 : 0,
    lrclibFatalCount: lrclibSnap.fatalCount,
    lrclibBreakerOpen: lrclibSnap.open ? 1 : 0,
  };
}
