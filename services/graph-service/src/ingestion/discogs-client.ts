import type { DiscogsCollectionPage, DiscogsRelease } from './types.js';

/** Minimal logger interface — satisfied by Fastify's app.log (pino) and by console. */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface DiscogsClientConfig {
  token: string;
  userAgent: string;
  delayMs: number;
  /** Minimum backoff in ms for 429 retry. Defaults to 1000. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Optional structured logger; defaults to console when omitted. Pass app.log in production. */
  logger?: Logger;
}

const BASE_URL = 'https://api.discogs.com';
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 32_000;
// Backoff starts here on 429 — independent of delayMs so it's always non-zero in production.
const DEFAULT_BACKOFF_BASE_MS = 1_000;

export class DiscogsClient {
  private readonly token: string;
  private readonly userAgent: string;
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  constructor(config: DiscogsClientConfig) {
    this.token = config.token;
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
  }

  async getCollectionReleases(
    username: string,
    page: number,
    perPage: number,
  ): Promise<DiscogsCollectionPage> {
    const url = `${BASE_URL}/users/${encodeURIComponent(username)}/collection/folders/0/releases?page=${page}&per_page=${perPage}`;
    return this.fetchWithBackoff<DiscogsCollectionPage>(url);
  }

  async getRelease(releaseId: number): Promise<DiscogsRelease> {
    const url = `${BASE_URL}/releases/${releaseId}`;
    return this.fetchWithBackoff<DiscogsRelease>(url);
  }

  private async fetchWithBackoff<T>(url: string): Promise<T> {
    let attempt = 0;
    // Backoff starts at backoffBaseMs (independent of delayMs so it's safe even when delayMs=0).
    let currentDelay = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Discogs token=${this.token}`,
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        // Honour the server-specified Retry-After delay when present.
        // Validate the parsed value — a non-integer header produces NaN which Math.max
        // propagates, effectively disabling backoff. Fall back to 0 on invalid values.
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
        const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
        const waitMs = Math.max(currentDelay, retryAfterMs);
        this.log.warn(
          `[discogs-client] Rate limited (429) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        // Exponential backoff, capped at MAX_BACKOFF_MS
        currentDelay = Math.min(Math.max(waitMs, this.backoffBaseMs) * 2, MAX_BACKOFF_MS);
        attempt++;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Discogs API error ${response.status} ${response.statusText} for ${url}`);
      }

      const data = (await response.json()) as T;

      // Polite delay between successful requests to stay within rate limits (60 req/min)
      await this.sleep(this.delayMs);

      return data;
    }

    throw new Error(
      `Discogs API: exceeded max retries (${MAX_RETRIES}) due to rate limiting for ${url}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
