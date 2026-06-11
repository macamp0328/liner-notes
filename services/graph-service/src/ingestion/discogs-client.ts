import type {
  DiscogsArtistProfile,
  DiscogsCollectionPage,
  DiscogsMasterRelease,
  DiscogsMasterVersionsPage,
  DiscogsRelease,
} from './types.js';
import {
  createRateLimitedFetch,
  type Logger,
  type RateLimitedFetch,
} from './rate-limited-fetch.js';

// Logger lives in rate-limited-fetch.ts now; re-exported here so the many existing
// importers of `Logger` from this module keep working unchanged.
export type { Logger } from './rate-limited-fetch.js';

export interface DiscogsClientConfig {
  token: string;
  userAgent: string;
  delayMs: number;
  /** Minimum backoff in ms for 429 retry. Defaults to 1000. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  /** Optional structured logger; defaults to console when omitted. Pass app.log in production. */
  logger?: Logger;
}

const BASE_URL = 'https://api.discogs.com';
const MAX_RETRIES = 5;
// Backoff starts here on 429 — independent of delayMs so it's always non-zero in production.
const DEFAULT_BACKOFF_BASE_MS = 1_000;

export class DiscogsClient {
  private readonly token: string;
  private readonly userAgent: string;
  private readonly rlFetch: RateLimitedFetch;

  constructor(config: DiscogsClientConfig) {
    this.token = config.token;
    this.userAgent = config.userAgent;
    this.rlFetch = createRateLimitedFetch({
      label: 'discogs-client',
      apiName: 'Discogs API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      retryStatuses: [429],
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
    });
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

  async getMaster(masterDiscogsId: number): Promise<DiscogsMasterRelease> {
    const url = `${BASE_URL}/masters/${masterDiscogsId}`;
    return this.fetchWithBackoff<DiscogsMasterRelease>(url);
  }

  async getMasterVersions(
    masterDiscogsId: number,
    page = 1,
    perPage = 100,
  ): Promise<DiscogsMasterVersionsPage> {
    const url = `${BASE_URL}/masters/${masterDiscogsId}/versions?page=${page}&per_page=${perPage}`;
    return this.fetchWithBackoff<DiscogsMasterVersionsPage>(url);
  }

  async getArtist(artistId: number): Promise<DiscogsArtistProfile> {
    const url = `${BASE_URL}/artists/${artistId}`;
    return this.fetchWithBackoff<DiscogsArtistProfile>(url);
  }

  private async fetchWithBackoff<T>(url: string): Promise<T> {
    const response = await this.rlFetch(url, {
      headers: {
        Authorization: `Discogs token=${this.token}`,
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Discogs API error ${response.status} ${response.statusText} for ${url}`);
    }

    return (await response.json()) as T;
  }
}
