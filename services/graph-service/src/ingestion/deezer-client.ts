import type { Logger } from './discogs-client.js';

export interface DeezerClientConfig {
  /** Milliseconds to sleep after every successful request. 120ms stays well under 50 req/5s. */
  delayMs: number;
  /** Minimum backoff on 429. Defaults to 1000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  logger?: Logger;
}

export interface DeezerTrackData {
  bpm: number | null;
  gain: number | null;
}

interface DeezerTrackResponse {
  id?: number;
  bpm?: number;
  gain?: number;
  error?: { type: string; message: string; code: number };
}

const BASE_URL = 'https://api.deezer.com';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const MAX_BACKOFF_MS = 32_000;

/**
 * HTTP client for the Deezer public API.
 *
 * Deezer exposes a direct ISRC lookup (`GET /track/isrc:{ISRC}`) that needs no API key,
 * so this client keys cleanly off `t.isrc` (populated by the track-musicbrainz
 * enrichment) with zero fuzzy matching. It surfaces only `bpm` and `gain` — Deezer
 * provides nothing else useful for audio-feature enrichment.
 */
export class DeezerClient {
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  constructor(config: DeezerClientConfig) {
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
  }

  /**
   * Look up a track by ISRC. Returns BPM and gain (a loudness figure) from Deezer.
   * Returns null when the ISRC is not in Deezer's catalog or carries no usable data.
   * Deezer returns 0 for unknown bpm/gain — these are coerced to null.
   */
  async getTrackByIsrc(isrc: string): Promise<DeezerTrackData | null> {
    const url = `${BASE_URL}/track/isrc:${encodeURIComponent(isrc)}`;

    const response = await this.fetchWithBackoff<DeezerTrackResponse>(url);

    // null means 404 — ISRC not in Deezer catalog.
    if (response === null) return null;

    // Deezer returns a 200 with an error object for unknown ISRCs in some cases.
    if (response.error !== undefined || response.id === undefined) {
      return null;
    }

    const bpm = response.bpm != null && response.bpm !== 0 ? response.bpm : null;
    const gain = response.gain != null && response.gain !== 0 ? response.gain : null;

    if (bpm === null && gain === null) return null;
    return { bpm, gain };
  }

  private async fetchWithBackoff<T>(url: string): Promise<T | null> {
    let attempt = 0;
    let currentDelay = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
        const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
        const waitMs = Math.max(currentDelay, retryAfterMs);
        const reason = response.status === 429 ? 'Rate limited' : 'Service unavailable';
        this.log.warn(
          `[deezer-client] ${reason} (${response.status}) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        currentDelay = Math.min(currentDelay * 2, MAX_BACKOFF_MS);
        attempt++;
        continue;
      }

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Deezer API error ${response.status} ${response.statusText} for ${url}`);
      }

      const data = (await response.json()) as T;
      await this.sleep(this.delayMs);
      return data;
    }

    throw new Error(`Deezer API: exceeded max retries (${MAX_RETRIES}) for ${url}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Build a DeezerClient. Deezer's public API needs no key, so this always returns a
 * client — there is no env gate.
 */
export function buildDeezerClientFromEnv(logger?: Logger): DeezerClient {
  return new DeezerClient({
    delayMs: 120,
    ...(logger !== undefined ? { logger } : {}),
  });
}
