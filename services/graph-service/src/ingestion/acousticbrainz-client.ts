import type { Logger } from './discogs-client.js';

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
  logger?: Logger;
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
const MAX_BACKOFF_MS = 32_000;

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
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  constructor(config: AcousticBrainzClientConfig) {
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
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
    const lowLevel = await this.fetchWithBackoff<BulkResponse<LowLevelDocument>>(
      `${BASE_URL}/low-level?recording_ids=${recordingIds}`,
    );
    const highLevel = await this.fetchWithBackoff<BulkResponse<HighLevelDocument>>(
      `${BASE_URL}/high-level?recording_ids=${recordingIds}`,
    );

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
    let attempt = 0;
    let currentDelay = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
        const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
        const waitMs = Math.max(currentDelay, retryAfterMs);
        const reason = response.status === 429 ? 'Rate limited' : 'Service unavailable';
        this.log.warn(
          `[acousticbrainz-client] ${reason} (${response.status}) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        currentDelay = Math.min(currentDelay * 2, MAX_BACKOFF_MS);
        attempt++;
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `AcousticBrainz API error ${response.status} ${response.statusText} for ${url}`,
        );
      }

      const data = (await response.json()) as T;
      await this.sleep(this.delayMs);
      return data;
    }

    throw new Error(`AcousticBrainz API: exceeded max retries (${MAX_RETRIES}) for ${url}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    ...(logger !== undefined ? { logger } : {}),
  });
}
