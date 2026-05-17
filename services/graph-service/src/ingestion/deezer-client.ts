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
   * Look up a track by ISRC. Returns BPM and gain (loudness) from Deezer.
   * Returns null when the ISRC is not in Deezer's catalog.
   * Deezer returns 0 for unknown bpm/gain — these are coerced to null.
   */
  async getTrackByIsrc(isrc: string): Promise<DeezerTrackData | null> {
    const url = `${BASE_URL}/track/isrc:${encodeURIComponent(isrc)}`;

    let response: DeezerTrackResponse;
    try {
      response = await this.fetchWithBackoff<DeezerTrackResponse>(url);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found (404)')) {
        return null;
      }
      throw err;
    }

    // Deezer returns a 200 with an error object for unknown ISRCs in some cases
    if (response.error !== undefined || response.id === undefined) {
      return null;
    }

    const bpm = response.bpm != null && response.bpm !== 0 ? response.bpm : null;
    const gain = response.gain != null && response.gain !== 0 ? response.gain : null;

    if (bpm === null && gain === null) return null;
    return { bpm, gain };
  }

  private async fetchWithBackoff<T>(url: string): Promise<T> {
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
        this.log.warn(
          `[deezer-client] Rate limited (${response.status}) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        currentDelay = Math.min(currentDelay * 2, 32_000);
        attempt++;
        continue;
      }

      if (response.status === 404) {
        throw new Error(`Deezer: not found (404) for ${url}`);
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

export function buildDeezerClientFromEnv(logger?: Logger): DeezerClient {
  return new DeezerClient({
    delayMs: 120,
    ...(logger !== undefined ? { logger } : {}),
  });
}
