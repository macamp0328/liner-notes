import {
  createRateLimitedFetch,
  type Logger,
  type RateLimitedFetch,
} from './rate-limited-fetch.js';
import {
  buildCircuitBreaker,
  closedSnapshot,
  CircuitBreakerOpenError,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
import { BULK_OUTBOUND_TIMEOUT_MS, resolveOutboundTimeoutMs } from './outbound-timeout.js';

/**
 * Acoustic features for a single recording, as resolved from AcousticBrainz.
 *
 * The first five fields are physically measured (Essentia low-level descriptors) and are
 * trustworthy. `danceabilityEstimate` and `voiceInstrumental` are model-estimated
 * (high-level classifiers) — they are AcousticBrainz's own estimates, NOT Spotify/Echo
 * Nest values, and must never be presented as equivalent to them. Every field is
 * nullable: AcousticBrainz coverage is crowd-sourced and best-effort.
 */
export interface AcousticBrainzFeatures {
  /** Beats per minute, from low-level `rhythm.bpm`. */
  tempo: number | null;
  /** Tonic, e.g. "C" or "A#", from low-level `tonal.key_key`. */
  musicalKey: string | null;
  /** "major" | "minor", from low-level `tonal.key_scale`. */
  musicalScale: string | null;
  /** Average loudness, from low-level `lowlevel.average_loudness`. */
  loudnessDb: number | null;
  /** Dynamic complexity, from low-level `lowlevel.dynamic_complexity`. */
  dynamicComplexity: number | null;
  /** Model-estimated danceability probability 0-1, from high-level `danceability.all.danceable`. */
  danceabilityEstimate: number | null;
  /** Model-estimated "voice" | "instrumental", from high-level `voice_instrumental.value`. */
  voiceInstrumental: string | null;
}

export interface AcousticBrainzClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every successful request, to stay polite. */
  delayMs: number;
  /** Minimum backoff on 429/503. Defaults to 2000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Per-request timeout in ms (#357). Falls back to the shared fetch default when omitted. */
  timeoutMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  logger?: Logger;
  /** Disable the per-source circuit breaker (#242); on by default. */
  disableCircuitBreaker?: boolean;
}

/**
 * AcousticBrainz bulk responses are keyed by recording MBID, then by submission offset
 * (a stringified integer — "0" is the first/oldest submission). We always read "0".
 */
type BulkResponse<T> = Record<string, Record<string, T> | undefined>;

interface LowLevelDocument {
  rhythm?: { bpm?: unknown };
  tonal?: { key_key?: unknown; key_scale?: unknown };
  lowlevel?: { average_loudness?: unknown; dynamic_complexity?: unknown };
}

interface HighLevelDocument {
  highlevel?: {
    danceability?: { all?: { danceable?: unknown } };
    voice_instrumental?: { value?: unknown };
  };
}

const BASE_URL = 'https://acousticbrainz.org/api/v1';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;

/** AcousticBrainz caps a single bulk request at 25 recording MBIDs. */
export const MAX_RECORDING_IDS_PER_CALL = 25;

/** Return the value when it is a finite non-zero number, otherwise null. */
function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0 ? value : null;
}

/** Return the value when it is a non-empty trimmed string, otherwise null. */
function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * HTTP client for the AcousticBrainz bulk API.
 *
 * AcousticBrainz is a frozen-but-live MusicBrainz sister project: submissions ended in
 * 2022 but the API stays available. It is keyed by MusicBrainz recording MBID, so this
 * client is only useful for Track nodes that already carry a `recordingMbid` (populated
 * by the track-musicbrainz enrichment).
 */
export class AcousticBrainzClient {
  private readonly userAgent: string;
  private readonly rlFetch: RateLimitedFetch;
  private readonly breaker: CircuitBreaker | undefined;

  constructor(config: AcousticBrainzClientConfig) {
    this.userAgent = config.userAgent;
    this.breaker =
      config.disableCircuitBreaker === true
        ? undefined
        : buildCircuitBreaker('acousticbrainz', config.logger);
    this.rlFetch = createRateLimitedFetch({
      label: 'acousticbrainz-client',
      apiName: 'AcousticBrainz API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      retryStatuses: [429, 503],
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
      ...(this.breaker !== undefined ? { breaker: this.breaker } : {}),
    });
  }

  /** Current circuit-breaker state for run-summary surfacing; closed when the breaker is off. */
  breakerSnapshot(): CircuitBreakerSnapshot {
    return this.breaker?.snapshot() ?? closedSnapshot('acousticbrainz');
  }

  /**
   * Fetch acoustic features for up to {@link MAX_RECORDING_IDS_PER_CALL} recording MBIDs.
   *
   * Issues one bulk `low-level` request and one bulk `high-level` request, then merges
   * the two by MBID. MBIDs that AcousticBrainz has no analysis for are simply absent
   * from the returned map — the caller treats a missing entry as "all features null".
   */
  async getFeatures(mbids: string[]): Promise<Map<string, AcousticBrainzFeatures>> {
    const result = new Map<string, AcousticBrainzFeatures>();
    if (mbids.length === 0) return result;
    if (mbids.length > MAX_RECORDING_IDS_PER_CALL) {
      throw new Error(
        `AcousticBrainz: getFeatures accepts at most ${MAX_RECORDING_IDS_PER_CALL} MBIDs, got ${mbids.length}`,
      );
    }

    const recordingIds = mbids.join(';');
    let lowLevel: BulkResponse<LowLevelDocument>;
    let highLevel: BulkResponse<HighLevelDocument>;
    try {
      lowLevel = await this.fetchWithBackoff<BulkResponse<LowLevelDocument>>(
        `${BASE_URL}/low-level?recording_ids=${recordingIds}`,
      );
      highLevel = await this.fetchWithBackoff<BulkResponse<HighLevelDocument>>(
        `${BASE_URL}/high-level?recording_ids=${recordingIds}`,
      );
    } catch (err) {
      // An open breaker leaves every MBID absent from the result map (= all features null).
      if (err instanceof CircuitBreakerOpenError) return result;
      throw err;
    }

    for (const mbid of mbids) {
      // eslint-disable-next-line security/detect-object-injection
      const low = lowLevel[mbid]?.['0'];
      // eslint-disable-next-line security/detect-object-injection
      const high = highLevel[mbid]?.['0'];
      if (low === undefined && high === undefined) continue;

      result.set(mbid, {
        tempo: toNumberOrNull(low?.rhythm?.bpm),
        musicalKey: toStringOrNull(low?.tonal?.key_key),
        musicalScale: toStringOrNull(low?.tonal?.key_scale),
        loudnessDb: toNumberOrNull(low?.lowlevel?.average_loudness),
        dynamicComplexity: toNumberOrNull(low?.lowlevel?.dynamic_complexity),
        danceabilityEstimate: toNumberOrNull(high?.highlevel?.danceability?.all?.danceable),
        voiceInstrumental: toStringOrNull(high?.highlevel?.voice_instrumental?.value),
      });
    }

    return result;
  }

  private async fetchWithBackoff<T>(url: string): Promise<T> {
    const response = await this.rlFetch(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `AcousticBrainz API error ${response.status} ${response.statusText} for ${url}`,
      );
    }

    return (await response.json()) as T;
  }
}

/**
 * Build an AcousticBrainzClient from environment variables.
 *
 * AcousticBrainz needs no API key, so this always returns a client: `ACOUSTICBRAINZ_USER_AGENT`
 * is an optional politeness header that falls back to a sensible default when unset.
 */
export function buildAcousticBrainzClientFromEnv(logger?: Logger): AcousticBrainzClient {
  const userAgent = process.env['ACOUSTICBRAINZ_USER_AGENT'] ?? 'liner-notes/1.0';
  return new AcousticBrainzClient({
    userAgent,
    delayMs: 1_000,
    timeoutMs: resolveOutboundTimeoutMs(BULK_OUTBOUND_TIMEOUT_MS),
    ...(logger !== undefined ? { logger } : {}),
  });
}
