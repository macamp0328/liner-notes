import {
  createRateLimitedFetch,
  type Logger,
  type RateLimitedFetch,
} from './rate-limited-fetch.js';

export interface LrclibClientConfig {
  /**
   * Identifying User-Agent. LRCLIB's API explicitly asks callers to send an app
   * name / version / contact string — unlike Genius, this is a polite identifier,
   * not a browser disguise.
   */
  userAgent: string;
  /** Trailing sleep after every successful request. Concurrency is the rate ceiling, so this is small. */
  delayMs: number;
  /** Minimum backoff on a retryable status. Defaults to 1000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  /** Optional structured logger; defaults to console when omitted. Pass app.log in production. */
  logger?: Logger;
}

interface LrclibResponse {
  plainLyrics?: string | null;
}

const BASE_URL = 'https://lrclib.net/api/get';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_USER_AGENT = 'liner-notes/1.0 (+https://github.com/macamp0328/liner-notes)';
const DEFAULT_DELAY_MS = 0;

/**
 * HTTP client for LRCLIB's free, key-less lyrics API — the primary lyrics source.
 *
 * Promoted from a raw `fetch()` to a hardened client (#247) so it matches the other
 * external clients: bounded retry on transient/5xx via the shared `createRateLimitedFetch`
 * core, capped backoff, and an identifying User-Agent (which LRCLIB requests). A transient
 * `LRCLIB 504` that used to drop a candidate now retries instead.
 */
export class LrclibClient {
  private readonly userAgent: string;
  private readonly rlFetch: RateLimitedFetch;

  constructor(config: LrclibClientConfig) {
    this.userAgent = config.userAgent;
    this.rlFetch = createRateLimitedFetch({
      label: 'lrclib-client',
      apiName: 'LRCLIB API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      retryStatuses: [429, 500, 502, 503, 504],
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
  }

  /**
   * Look up plain lyrics for a track. Returns the lyrics on 200, `null` on a 404 (LRCLIB
   * has no match) or a 200 with no `plainLyrics`, and throws on any other non-ok status
   * (after the retry budget is spent — a retryable status exhausts to `RetriesExhaustedError`).
   */
  async getLyrics(artistName: string, title: string): Promise<string | null> {
    const url = new URL(BASE_URL);
    url.searchParams.set('track_name', title);
    url.searchParams.set('artist_name', artistName);

    const response = await this.rlFetch(url.toString(), {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`LRCLIB API error ${response.status} for ${url.toString()}`);
    }

    const data = (await response.json()) as LrclibResponse;
    return data.plainLyrics ?? null;
  }
}

/**
 * Build an {@link LrclibClient} from environment variables. LRCLIB needs no key, so this
 * always returns a client. `LRCLIB_USER_AGENT` overrides the polite default identifier;
 * `LRCLIB_REQUEST_DELAY_MS` overrides the per-request spacing (clamped — malformed/negative
 * values fall back to the default).
 */
export function buildLrclibClientFromEnv(logger?: Logger): LrclibClient {
  const userAgent = process.env['LRCLIB_USER_AGENT'] || DEFAULT_USER_AGENT;
  const parsed = parseInt(process.env['LRCLIB_REQUEST_DELAY_MS'] ?? '', 10);
  const delayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;
  return new LrclibClient({
    userAgent,
    delayMs,
    ...(logger !== undefined ? { logger } : {}),
  });
}
