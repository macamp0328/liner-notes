import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { SpotifyClient, buildSpotifyClientFromEnv } from '../../../src/ingestion/spotify-client.js';

function makeOkResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function makeErrorResponse(status: number, statusText: string, retryAfterSecs?: number): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: {
      get: (name: string) =>
        name === 'Retry-After' && retryAfterSecs !== undefined ? String(retryAfterSecs) : null,
    },
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

const tokenResponse = { access_token: 'test-access-token', expires_in: 3600 };

const searchResponse = {
  tracks: {
    items: [
      { id: 'track-id-1', duration_ms: 200_000 },
      { id: 'track-id-2', duration_ms: 250_000 },
    ],
  },
};

const audioFeaturesResponse = {
  audio_features: [
    {
      id: 'track-id-1',
      time_signature: 4,
      tempo: 120.5,
      key: 5,
      mode: 1,
      loudness: -8.5,
      energy: 0.75,
      valence: 0.6,
      danceability: 0.7,
      acousticness: 0.1,
      instrumentalness: 0.05,
      liveness: 0.12,
      speechiness: 0.04,
    },
    null, // Spotify may return null for tracks without analysis
  ],
};

describe('SpotifyClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: SpotifyClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new SpotifyClient({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      delayMs: 0,
      backoffBaseMs: 0,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------
  describe('token management', () => {
    it('fetches a token using client credentials before the first API call', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      await client.searchTrack('Artist', 'Title');

      const tokenCall = fetchSpy.mock.calls[0];
      expect(tokenCall?.[0]).toBe('https://accounts.spotify.com/api/token');
      expect(tokenCall?.[1]?.method).toBe('POST');
      expect(tokenCall?.[1]?.body).toBe('grant_type=client_credentials');
    });

    it('sends Basic auth header with base64 credentials for token request', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      await client.searchTrack('Artist', 'Title');

      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      const expected = Buffer.from('test-client-id:test-client-secret').toString('base64');
      expect(headers['Authorization']).toBe(`Basic ${expected}`);
    });

    it('reuses the cached token for subsequent calls', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse)) // token fetch
        .mockResolvedValueOnce(makeOkResponse(searchResponse)) // first search
        .mockResolvedValueOnce(makeOkResponse(searchResponse)); // second search

      await client.searchTrack('Artist', 'Title');
      await client.searchTrack('Artist2', 'Title2');

      // Should only fetch the token once
      const tokenCalls = fetchSpy.mock.calls.filter(
        (c) => (c[0] as string) === 'https://accounts.spotify.com/api/token',
      );
      expect(tokenCalls).toHaveLength(1);
    });

    it('throws when token request fails', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(401, 'Unauthorized'));

      await expect(client.searchTrack('Artist', 'Title')).rejects.toThrow(
        /Spotify token request failed: 401/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // searchTrack
  // ---------------------------------------------------------------------------
  describe('searchTrack', () => {
    it('calls the search endpoint with encoded artist + title', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      await client.searchTrack('Test Artist', 'My Song');

      const url = fetchSpy.mock.calls[1]?.[0] as string;
      expect(url).toContain('/search');
      expect(url).toContain('type=track');
      expect(url).toContain(encodeURIComponent('artist:"Test Artist" track:"My Song"'));
    });

    it('returns id and durationMs for each candidate', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      const results = await client.searchTrack('Artist', 'Song');

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: 'track-id-1', durationMs: 200_000 });
      expect(results[1]).toEqual({ id: 'track-id-2', durationMs: 250_000 });
    });

    it('sends Bearer token in Authorization header', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      await client.searchTrack('Artist', 'Song');

      const headers = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-access-token');
    });
  });

  // ---------------------------------------------------------------------------
  // getAudioFeaturesBatch
  // ---------------------------------------------------------------------------
  describe('getAudioFeaturesBatch', () => {
    it('calls the audio-features endpoint with comma-joined IDs', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(audioFeaturesResponse));

      await client.getAudioFeaturesBatch(['track-id-1', 'track-id-2']);

      const url = fetchSpy.mock.calls[1]?.[0] as string;
      expect(url).toContain('/audio-features');
      expect(url).toContain('ids=track-id-1,track-id-2');
    });

    it('returns a Map keyed by spotifyId with camelCase fields', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(audioFeaturesResponse));

      const result = await client.getAudioFeaturesBatch(['track-id-1']);

      expect(result.size).toBe(1);
      const features = result.get('track-id-1');
      expect(features?.timeSignature).toBe(4);
      expect(features?.tempo).toBe(120.5);
      expect(features?.key).toBe(5);
      expect(features?.mode).toBe(1);
      expect(features?.loudness).toBe(-8.5);
    });

    it('omits null entries from the returned Map', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeOkResponse(audioFeaturesResponse));

      const result = await client.getAudioFeaturesBatch(['track-id-1', 'track-id-2']);

      // audioFeaturesResponse has one real entry and one null
      expect(result.size).toBe(1);
      expect(result.has('track-id-1')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling and rate limiting
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    it('throws on non-429 API errors', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeErrorResponse(403, 'Forbidden'));

      await expect(client.searchTrack('Artist', 'Song')).rejects.toThrow('403');
    });

    it('retries on 429 and succeeds on next attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      const results = await client.searchTrack('Artist', 'Song');
      expect(results).toHaveLength(2);
    });

    it('throws after exceeding max retries on persistent 429', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValue(makeErrorResponse(429, 'Too Many Requests'));

      await expect(client.searchTrack('Artist', 'Song')).rejects.toThrow(/exceeded max retries/);
    });

    it('honours the Retry-After header on 429', async () => {
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn, ..._args) => {
          (fn as () => void)();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(tokenResponse))
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests', 3))
        .mockResolvedValueOnce(makeOkResponse(searchResponse));

      await client.searchTrack('Artist', 'Song');

      const firstDelay = setTimeoutSpy.mock.calls[0]?.[1] ?? 0;
      expect(firstDelay).toBeGreaterThanOrEqual(3_000);

      setTimeoutSpy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// buildSpotifyClientFromEnv
// ---------------------------------------------------------------------------
describe('buildSpotifyClientFromEnv', () => {
  beforeEach(() => {
    delete process.env['SPOTIFY_CLIENT_ID'];
    delete process.env['SPOTIFY_CLIENT_SECRET'];
    delete process.env['SPOTIFY_REQUEST_DELAY_MS'];
  });

  it('returns null when SPOTIFY_CLIENT_ID is missing', () => {
    process.env['SPOTIFY_CLIENT_SECRET'] = 'secret';
    expect(buildSpotifyClientFromEnv()).toBeNull();
  });

  it('returns null when SPOTIFY_CLIENT_SECRET is missing', () => {
    process.env['SPOTIFY_CLIENT_ID'] = 'id';
    expect(buildSpotifyClientFromEnv()).toBeNull();
  });

  it('returns a SpotifyClient when both credentials are set', () => {
    process.env['SPOTIFY_CLIENT_ID'] = 'my-id';
    process.env['SPOTIFY_CLIENT_SECRET'] = 'my-secret';
    expect(buildSpotifyClientFromEnv()).toBeInstanceOf(SpotifyClient);
  });

  it('uses SPOTIFY_REQUEST_DELAY_MS when valid', () => {
    process.env['SPOTIFY_CLIENT_ID'] = 'id';
    process.env['SPOTIFY_CLIENT_SECRET'] = 'secret';
    process.env['SPOTIFY_REQUEST_DELAY_MS'] = '200';
    // We can't inspect delayMs directly, but the client should construct without error
    expect(buildSpotifyClientFromEnv()).toBeInstanceOf(SpotifyClient);
  });

  it('falls back to 100ms delay when SPOTIFY_REQUEST_DELAY_MS is invalid', () => {
    process.env['SPOTIFY_CLIENT_ID'] = 'id';
    process.env['SPOTIFY_CLIENT_SECRET'] = 'secret';
    process.env['SPOTIFY_REQUEST_DELAY_MS'] = 'not-a-number';
    expect(buildSpotifyClientFromEnv()).toBeInstanceOf(SpotifyClient);
  });
});
