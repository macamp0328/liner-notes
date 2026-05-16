import type { Logger } from './discogs-client.js';

export type { Logger };

export interface SpotifyClientConfig {
  clientId: string;
  clientSecret: string;
  delayMs: number;
  /** Minimum backoff in ms for 429 retry. Defaults to 1000. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  logger?: Logger;
}

export interface SpotifyTrackSearchResult {
  id: string;
  durationMs: number;
}

export interface SpotifyAudioFeatures {
  id: string;
  timeSignature: number;
  tempo: number;
  key: number;
  mode: number;
  loudness: number;
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  speechiness: number;
}

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
}

interface SpotifySearchResponse {
  tracks: {
    items: Array<{
      id: string;
      duration_ms: number;
    }>;
  };
}

interface SpotifyAudioFeaturesResponse {
  audio_features: Array<{
    id: string;
    time_signature: number;
    tempo: number;
    key: number;
    mode: number;
    loudness: number;
    energy: number;
    valence: number;
    danceability: number;
    acousticness: number;
    instrumentalness: number;
    liveness: number;
    speechiness: number;
  } | null>;
}

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 32_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const SEARCH_LIMIT = 5;

export class SpotifyClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: SpotifyClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
  }

  private async ensureToken(): Promise<string> {
    const nowMs = Date.now();
    // Refresh 60s before expiry to avoid using stale tokens
    if (this.accessToken && nowMs < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`Spotify token request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SpotifyTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = nowMs + data.expires_in * 1_000;
    return this.accessToken;
  }

  async searchTrack(artistName: string, title: string): Promise<SpotifyTrackSearchResult[]> {
    const safeArtist = artistName.replace(/"/g, '\\"');
    const safeTitle = title.replace(/"/g, '\\"');
    const q = encodeURIComponent(`artist:"${safeArtist}" track:"${safeTitle}"`);
    const url = `${API_BASE}/search?q=${q}&type=track&limit=${SEARCH_LIMIT}`;
    const data = await this.fetchWithBackoff<SpotifySearchResponse>(url);
    return data.tracks.items.map((item) => ({
      id: item.id,
      durationMs: item.duration_ms,
    }));
  }

  async getAudioFeaturesBatch(ids: string[]): Promise<Map<string, SpotifyAudioFeatures>> {
    const url = `${API_BASE}/audio-features?ids=${ids.join(',')}`;
    const data = await this.fetchWithBackoff<SpotifyAudioFeaturesResponse>(url);
    const result = new Map<string, SpotifyAudioFeatures>();
    for (const item of data.audio_features) {
      if (item === null) continue;
      result.set(item.id, {
        id: item.id,
        timeSignature: item.time_signature,
        tempo: item.tempo,
        key: item.key,
        mode: item.mode,
        loudness: item.loudness,
        energy: item.energy,
        valence: item.valence,
        danceability: item.danceability,
        acousticness: item.acousticness,
        instrumentalness: item.instrumentalness,
        liveness: item.liveness,
        speechiness: item.speechiness,
      });
    }
    return result;
  }

  private async fetchWithBackoff<T>(url: string): Promise<T> {
    let attempt = 0;
    let currentDelay = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      const token = await this.ensureToken();
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
        const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
        const waitMs = Math.max(currentDelay, retryAfterMs);
        this.log.warn(
          `[spotify-client] Rate limited (429) on attempt ${attempt + 1}/${MAX_RETRIES + 1} — waiting ${waitMs}ms`,
        );
        await this.sleep(waitMs);
        currentDelay = Math.min(Math.max(waitMs, this.backoffBaseMs) * 2, MAX_BACKOFF_MS);
        attempt++;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Spotify API error ${response.status} ${response.statusText} for ${url}`);
      }

      const data = (await response.json()) as T;
      await this.sleep(this.delayMs);
      return data;
    }

    throw new Error(
      `Spotify API: exceeded max retries (${MAX_RETRIES}) due to rate limiting for ${url}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const DEFAULT_DELAY_MS = 100;
const MIN_DELAY_MS = 0;

export function buildSpotifyClientFromEnv(logger?: Logger): SpotifyClient | null {
  const clientId = process.env['SPOTIFY_CLIENT_ID'];
  const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    return null;
  }

  const parsed = parseInt(process.env['SPOTIFY_REQUEST_DELAY_MS'] ?? '', 10);
  const delayMs = Number.isFinite(parsed) && parsed >= MIN_DELAY_MS ? parsed : DEFAULT_DELAY_MS;

  return new SpotifyClient({
    clientId,
    clientSecret,
    delayMs,
    ...(logger !== undefined ? { logger } : {}),
  });
}
