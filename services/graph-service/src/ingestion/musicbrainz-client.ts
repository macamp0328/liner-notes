import type { Logger } from './discogs-client.js';
import { transientNetworkCode } from './network-errors.js';

export interface MbReleaseEvent {
  mbReleaseId: string;
  countryCode: string | null;
  date: string | null;
  formats: string[];
}

/** A single track of a MusicBrainz release, carrying its recording MBID and ISRC. */
export interface MbRecordingTrack {
  /** 1-based ordinal position across the entire release tracklist (all media flattened). */
  position: number;
  title: string;
  /** Track length in whole seconds; null when MusicBrainz has no length on file. */
  lengthSeconds: number | null;
  recordingMbid: string;
  /** First registered ISRC for the recording; null when none is registered. */
  isrc: string | null;
}

/** A MusicBrainz recording identified by the fallback recording search. */
export interface MbRecordingMatch {
  recordingMbid: string;
  isrc: string | null;
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
    release?: { id: string };
  }>;
}

interface MbReleaseWithRecordingsResponse {
  id: string;
  media?: Array<{
    tracks?: Array<{
      id: string;
      title: string;
      length?: number | null;
      recording: {
        id: string;
        title: string;
        length?: number | null;
        isrcs?: string[];
      };
    }>;
  }>;
}

interface MbRecordingSearchResponse {
  recordings?: Array<{
    id: string;
    score: number;
    title: string;
    length?: number | null;
    isrcs?: string[];
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
/** Minimum MusicBrainz search score to accept a fallback recording match. */
const MIN_RECORDING_SEARCH_SCORE = 90;

/** Convert a MusicBrainz millisecond length to whole seconds; null for missing or non-positive values. */
function msToSeconds(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || ms <= 0) return null;
  return Math.round(ms / 1_000);
}

/** Strip double quotes so a value can be embedded inside a Lucene phrase query. */
function escapeLucenePhrase(value: string): string {
  return value.replace(/"/g, ' ').trim();
}

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
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found (404)')) {
        return null;
      }
      throw err;
    }

    const relation = response.relations.find(
      (r) =>
        r.type === 'discogs' && r.direction === 'backward' && r['release-group']?.id !== undefined,
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
   * Resolve a Discogs release ID to a MusicBrainz release MBID via the Discogs URL relation.
   * Returns null when the release is not linked in MusicBrainz.
   */
  async getReleaseMbidByDiscogsReleaseId(discogsReleaseId: number): Promise<string | null> {
    const resource = `https://www.discogs.com/release/${discogsReleaseId}`;
    const endpoint = `${BASE_URL}/url?resource=${encodeURIComponent(resource)}&inc=release-rels&fmt=json`;

    let response: MbUrlResponse;
    try {
      response = await this.fetchWithBackoff<MbUrlResponse>(endpoint);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found (404)')) {
        return null;
      }
      throw err;
    }

    const relation = response.relations.find(
      (r) => r.type === 'discogs' && r.direction === 'backward' && r.release?.id !== undefined,
    );
    return relation?.release?.id ?? null;
  }

  /**
   * Fetch the tracklist of a MusicBrainz release with recording MBIDs and ISRCs.
   * Flattens all media into a single ordinal-ordered list. Returns an empty array
   * when the release has no tracks.
   */
  async getRecordingsByReleaseMbid(mbReleaseId: string): Promise<MbRecordingTrack[]> {
    const endpoint = `${BASE_URL}/release/${encodeURIComponent(mbReleaseId)}?inc=recordings+isrcs&fmt=json`;
    const response = await this.fetchWithBackoff<MbReleaseWithRecordingsResponse>(endpoint);

    const tracks: MbRecordingTrack[] = [];
    let position = 0;
    for (const medium of response.media ?? []) {
      for (const track of medium.tracks ?? []) {
        position++;
        tracks.push({
          position,
          title: track.title,
          lengthSeconds: msToSeconds(track.length ?? track.recording.length),
          recordingMbid: track.recording.id,
          isrc: track.recording.isrcs?.[0] ?? null,
        });
      }
    }
    return tracks;
  }

  /**
   * Fallback path — search MusicBrainz directly for a recording by title and artist,
   * optionally constrained by duration. Only returns a match when the top result
   * scores at least MIN_RECORDING_SEARCH_SCORE. Returns null otherwise.
   */
  async searchRecording(
    title: string,
    artist: string,
    durationSeconds: number | null,
  ): Promise<MbRecordingMatch | null> {
    const cleanTitle = escapeLucenePhrase(title);
    const cleanArtist = escapeLucenePhrase(artist);
    if (cleanTitle === '' || cleanArtist === '') return null;

    let query = `recording:"${cleanTitle}" AND artist:"${cleanArtist}"`;
    if (durationSeconds !== null) {
      const lo = Math.max(0, durationSeconds * 1_000 - 2_000);
      const hi = durationSeconds * 1_000 + 2_000;
      query += ` AND dur:[${lo} TO ${hi}]`;
    }

    const endpoint = `${BASE_URL}/recording?query=${encodeURIComponent(query)}&limit=1&fmt=json`;

    let response: MbRecordingSearchResponse;
    try {
      response = await this.fetchWithBackoff<MbRecordingSearchResponse>(endpoint);
    } catch {
      return null;
    }

    const top = response.recordings?.[0];
    if (!top || top.score < MIN_RECORDING_SEARCH_SCORE) return null;
    return { recordingMbid: top.id, isrc: top.isrcs?.[0] ?? null };
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
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        const netCode = transientNetworkCode(err);
        if (netCode === null || attempt >= MAX_RETRIES) throw err;
        this.log.warn(
          `[musicbrainz-client] Network error (${netCode}) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${currentDelay}ms`,
        );
        await this.sleep(currentDelay);
        currentDelay = Math.min(currentDelay * 2, 32_000);
        attempt++;
        continue;
      }

      if (response.status === 429 || response.status === 503) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`MusicBrainz API: exceeded max retries (${MAX_RETRIES}) for ${url}`);
        }
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
        const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
        const waitMs = Math.max(currentDelay, retryAfterMs);
        const label = response.status === 429 ? 'Rate limited' : 'Service unavailable';
        this.log.warn(
          `[musicbrainz-client] ${label} (${response.status}) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
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

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        throw new Error(
          `MusicBrainz: received HTML response (status ${response.status}) for ${url}`,
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
