import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { MusicBrainzClient } from '../../../src/ingestion/musicbrainz-client.js';

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(body),
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

const mbUrlResponse = (mbid: string) => ({
  id: 'url-uuid',
  resource: 'https://www.discogs.com/artist/42',
  relations: [{ type: 'discogs', direction: 'backward', artist: { id: mbid, name: 'Test' } }],
});

const mbArtistResponse = (country?: string) => ({
  id: 'artist-mbid',
  name: 'Test Artist',
  country,
});

describe('MusicBrainzClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: MusicBrainzClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new MusicBrainzClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // getCountryByDiscogsId
  // -------------------------------------------------------------------------
  describe('getCountryByDiscogsId', () => {
    it('returns country code via two-step lookup', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('artist-mbid-1')))
        .mockResolvedValueOnce(makeOkResponse(mbArtistResponse('GB')));

      const result = await client.getCountryByDiscogsId(42);

      expect(result).toBe('GB');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const urlCall = fetchSpy.mock.calls[0]?.[0] as string;
      expect(urlCall).toContain('/url');
      expect(urlCall).toContain(encodeURIComponent('https://www.discogs.com/artist/42'));
      const artistCall = fetchSpy.mock.calls[1]?.[0] as string;
      expect(artistCall).toContain('/artist/artist-mbid-1');
    });

    it('returns null when artist is not in MusicBrainz (404 on URL lookup)', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));
      const result = await client.getCountryByDiscogsId(99);
      expect(result).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when URL lookup returns no artist relations', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({ id: 'url-uuid', resource: '...', relations: [] }),
      );
      const result = await client.getCountryByDiscogsId(1);
      expect(result).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when artist has no country set', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('mbid-no-country')))
        .mockResolvedValueOnce(makeOkResponse(mbArtistResponse(undefined)));

      const result = await client.getCountryByDiscogsId(7);
      expect(result).toBeNull();
    });

    it('trims whitespace from country code', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('mbid')))
        .mockResolvedValueOnce(makeOkResponse(mbArtistResponse(' US ')));

      const result = await client.getCountryByDiscogsId(1);
      expect(result).toBe('US');
    });

    it('retries on 429 and succeeds on subsequent attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
        .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('mbid')))
        .mockResolvedValueOnce(makeOkResponse(mbArtistResponse('JP')));

      const result = await client.getCountryByDiscogsId(5);
      expect(result).toBe('JP');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('returns null (does not throw) when URL lookup throws a network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      const result = await client.getCountryByDiscogsId(1);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getCountryByName
  // -------------------------------------------------------------------------
  describe('getCountryByName', () => {
    it('returns country when score is ≥ 90', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          artists: [{ id: 'mbid', name: 'Miles Davis', score: 100, country: 'US' }],
        }),
      );

      const result = await client.getCountryByName('Miles Davis');
      expect(result).toBe('US');
    });

    it('returns null when score is below 90', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({ artists: [{ id: 'mbid', name: 'Miles', score: 70, country: 'US' }] }),
      );

      const result = await client.getCountryByName('Miles');
      expect(result).toBeNull();
    });

    it('returns null when search results are empty', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse({ artists: [] }));
      const result = await client.getCountryByName('Unknown Artist');
      expect(result).toBeNull();
    });

    it('returns null when top result has no country', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({ artists: [{ id: 'mbid', name: 'Noname', score: 95 }] }),
      );
      const result = await client.getCountryByName('Noname');
      expect(result).toBeNull();
    });

    it('returns null (does not throw) on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      const result = await client.getCountryByName('Whoever');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // User-Agent header
  // -------------------------------------------------------------------------
  it('sends the configured User-Agent header on every request', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('mbid')))
      .mockResolvedValueOnce(makeOkResponse(mbArtistResponse('DE')));

    await client.getCountryByDiscogsId(1);

    for (const call of fetchSpy.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe('liner-notes/test');
    }
  });
});
