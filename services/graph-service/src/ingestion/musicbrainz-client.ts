import type { Logger } from './discogs-client.js';

export interface MbReleaseEvent {
  mbReleaseId: string;
  countryCode: string | null;
  date: string | null;
  formats: string[];
}

export interface MusicBrainzClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every successful request. 1100ms keeps us safely under 1 req/sec. */
  delayMs: number;
  /** Minimum backoff on 429/503. Defaults to 2000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  logger?: Logger;
}

interface MbUrlResponse {
  id: string;
  resource: string;
  relations: Array<{
    type: string;
    direction: string;
    artist?: { id: string; name: string };
    'release-group'?: { id: string };
  }>;
}

interface MbReleaseListResponse {
  'release-count': number;
  releases: Array<{
    id: string;
    'release-events'?: Array<{
      date?: string;
      area?: {
        'iso-3166-1-codes'?: string[];
      };
    }>;
    media?: Array<{ format?: string }>;
  }>;
}

interface MbArtistResponse {
  id: string;
  name: string;
  country?: string;
  area?: {
    'iso-3166-1-codes'?: string[];
  };
}

interface MbSearchResponse {
  artists: Array<{
    id: string;
    name: string;
    score: number;
    country?: string;
  }>;
}

const BASE_URL = 'https://musicbrainz.org/ws/2';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;

export class MusicBrainzClient {
  private readonly userAgent: string;
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  constructor(config: MusicBrainzClientConfig) {
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
  }

  /**
   * Resolve a Discogs master ID to a MusicBrainz release group MBID.
   * Returns null when the master is not linked in MusicBrainz.
   */
  async getReleaseGroupMbidByMasterDiscogsId(masterDiscogsId: number): Promise<string | null> {
    const resource = `https://www.discogs.com/master/${masterDiscogsId}`;
    const endpoint = `${BASE_URL}/url?resource=${encodeURIComponent(resource)}&inc=release-group-rels&fmt=json`;

    let response: MbUrlResponse;
    try {
      response = await this.fetchWithBackoff<MbUrlResponse>(endpoint);
    } catch {
      return null;
    }

    const relation = response.relations.find(
      (r) => r.type === 'release group' && r.direction === 'backward' && r['release-group']?.id,
    );
    return relation?.['release-group']?.id ?? null;
  }

  /**
   * Fetch all official release events for a MusicBrainz release group MBID.
   * Paginates until all releases are collected. Filters events where both countryCode and date are null.
   */
  async getReleaseEventsByReleaseGroupMbid(mbid: string): Promise<MbReleaseEvent[]> {
    const events: MbReleaseEvent[] = [];
    const limit = 100;
    let offset = 0;
    let totalCount = Infinity;

    while (offset < totalCount) {
      const endpoint =
        `${BASE_URL}/release?release-group=${encodeURIComponent(mbid)}` +
        `&status=official&inc=release-events&fmt=json&limit=${limit}&offset=${offset}`;

      const page = await this.fetchWithBackoff<MbReleaseListResponse>(endpoint);
      totalCount = page['release-count'];
      const releases = page.releases ?? [];

      for (const release of releases) {
        const formats = [
          ...new Set((release.media ?? []).map((m) => m.format).filter((f): f is string => !!f)),
        ];

        for (const event of release['release-events'] ?? []) {
          const countryCode = event.area?.['iso-3166-1-codes']?.[0] ?? null;
          const date = event.date?.trim() || null;

          if (countryCode === null && date === null) continue;

          events.push({ mbReleaseId: release.id, countryCode, date, formats });
        }
      }

      offset += releases.length;
      if (releases.length === 0) break;
    }

    return events;
  }

  /**
   * Look up an artist by Discogs ID and return their ISO 3166-1 alpha-2 country code.
   * Uses a two-step lookup: Discogs URL → MBID → artist country.
   * Returns null when the artist is not in MusicBrainz or has no country set.
   */
  async getCountryByDiscogsId(discogsId: number): Promise<string | null> {
    const urlResource = `https://www.discogs.com/artist/${discogsId}`;
    const urlEndpoint = `${BASE_URL}/url?resource=${encodeURIComponent(urlResource)}&inc=artist-rels&fmt=json`;

    let urlResponse: MbUrlResponse;
    try {
      urlResponse = await this.fetchWithBackoff<MbUrlResponse>(urlEndpoint);
    } catch {
      return null;
    }

    const relation = urlResponse.relations.find(
      (r) => r.type === 'discogs' && r.direction === 'backward' && r.artist?.id !== undefined,
    );
    const mbid = relation?.artist?.id;
    if (!mbid) return null;

    return this.getCountryByMbid(mbid);
  }

  /**
   * Search for an artist by name and return their ISO 3166-1 alpha-2 country code.
   * Only returns a result when MusicBrainz confidence score is ≥ 90.
   * Less reliable than getCountryByDiscogsId — use as fallback only.
   */
  async getCountryByName(name: string): Promise<string | null> {
    const searchEndpoint = `${BASE_URL}/artist?query=${encodeURIComponent(`artist:${name}`)}&limit=1&fmt=json`;

    let response: MbSearchResponse;
    try {
      response = await this.fetchWithBackoff<MbSearchResponse>(searchEndpoint);
    } catch {
      return null;
    }

    const topResult = response.artists[0];
    if (!topResult || topResult.score < 90) return null;
    return topResult.country?.trim() || null;
  }

  private async getCountryByMbid(mbid: string): Promise<string | null> {
    const artistEndpoint = `${BASE_URL}/artist/${encodeURIComponent(mbid)}?fmt=json`;

    let response: MbArtistResponse;
    try {
      response = await this.fetchWithBackoff<MbArtistResponse>(artistEndpoint);
    } catch {
      return null;
    }

    return response.country?.trim() || response.area?.['iso-3166-1-codes']?.[0]?.trim() || null;
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
        this.log.warn(
          `[musicbrainz-client] Rate limited (${response.status}) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        currentDelay = Math.min(currentDelay * 2, 32_000);
        attempt++;
        continue;
      }

      if (response.status === 404) {
        throw new Error(`MusicBrainz: not found (404) for ${url}`);
      }

      if (!response.ok) {
        throw new Error(
          `MusicBrainz API error ${response.status} ${response.statusText} for ${url}`,
        );
      }

      const data = (await response.json()) as T;
      await this.sleep(this.delayMs);
      return data;
    }

    throw new Error(`MusicBrainz API: exceeded max retries (${MAX_RETRIES}) for ${url}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function buildMusicBrainzClientFromEnv(logger?: Logger): MusicBrainzClient | null {
  const userAgent = process.env['MUSICBRAINZ_USER_AGENT'];
  if (!userAgent) return null;
  return new MusicBrainzClient({
    userAgent,
    delayMs: 1100,
    ...(logger !== undefined ? { logger } : {}),
  });
}
