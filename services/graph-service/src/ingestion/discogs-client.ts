import type { DiscogsCollectionPage, DiscogsRelease } from './types.js';

export interface DiscogsClientConfig {
  token: string;
  userAgent: string;
  delayMs: number;
}

const BASE_URL = 'https://api.discogs.com';
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 32_000;

export class DiscogsClient {
  private readonly token: string;
  private readonly userAgent: string;
  private readonly delayMs: number;

  constructor(config: DiscogsClientConfig) {
    this.token = config.token;
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
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
    let currentDelay = this.delayMs;

    while (attempt <= MAX_RETRIES) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Discogs token=${this.token}`,
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        console.warn(
          `[discogs-client] Rate limited (429) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${currentDelay}ms`,
        );
        await this.sleep(currentDelay);
        // Exponential backoff, capped at MAX_BACKOFF_MS
        currentDelay = Math.min(currentDelay * 2, MAX_BACKOFF_MS);
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
