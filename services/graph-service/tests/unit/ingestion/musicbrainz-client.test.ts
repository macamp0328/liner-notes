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

/**
 * Build a transient network-level error like the ones undici throws. `code`, when given,
 * is attached either as the error's `.cause.code` (the undici shape) or directly as `.code`.
 */
function makeNetworkError(
  message: string,
  code?: string,
  attachTo: 'cause' | 'self' = 'cause',
): Error {
  const err = new TypeError(message);
  if (code !== undefined) {
    if (attachTo === 'cause') {
      (err as Error & { cause?: unknown }).cause = Object.assign(new Error(message), { code });
    } else {
      (err as Error & { code?: unknown }).code = code;
    }
  }
  return err;
}

const mbReleaseRelationResponse = (mbid: string) => ({
  id: 'url-uuid',
  resource: 'https://www.discogs.com/release/567',
  relations: [{ type: 'discogs', direction: 'backward', release: { id: mbid } }],
});

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

    it('falls back to area iso-3166-1-codes when country is null', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('mbid-area')))
        .mockResolvedValueOnce(
          makeOkResponse({
            id: 'mbid-area',
            name: 'Area Artist',
            country: null,
            area: { 'iso-3166-1-codes': ['SE'] },
          }),
        );

      const result = await client.getCountryByDiscogsId(42);
      expect(result).toBe('SE');
    });

    it('prefers country over area when both are present', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeOkResponse(mbUrlResponse('mbid-both')))
        .mockResolvedValueOnce(
          makeOkResponse({
            id: 'mbid-both',
            name: 'Both Artist',
            country: 'GB',
            area: { 'iso-3166-1-codes': ['US'] },
          }),
        );

      const result = await client.getCountryByDiscogsId(99);
      expect(result).toBe('GB');
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
  // getReleaseGroupMbidByMasterDiscogsId
  // -------------------------------------------------------------------------
  describe('getReleaseGroupMbidByMasterDiscogsId', () => {
    it('returns the release group MBID when a discogs relation is found', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'url-uuid',
          resource: 'https://www.discogs.com/master/1234',
          relations: [
            {
              type: 'discogs',
              direction: 'backward',
              'target-type': 'release_group',
              release_group: { id: 'rg-mbid-abc' },
            },
          ],
        }),
      );

      const result = await client.getReleaseGroupMbidByMasterDiscogsId(1234);

      expect(result).toBe('rg-mbid-abc');
      const urlCall = fetchSpy.mock.calls[0]?.[0] as string;
      expect(urlCall).toContain('/url');
      expect(urlCall).toContain(encodeURIComponent('https://www.discogs.com/master/1234'));
      expect(urlCall).toContain('release-group-rels');
    });

    it('returns null when the master is not in MusicBrainz (404)', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));
      const result = await client.getReleaseGroupMbidByMasterDiscogsId(9999);
      expect(result).toBeNull();
    });

    it('returns null when relations list has no release-group entry', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'url-uuid',
          resource: 'https://www.discogs.com/master/1234',
          relations: [
            { type: 'artist', direction: 'backward', artist: { id: 'a1', name: 'Test' } },
          ],
        }),
      );
      const result = await client.getReleaseGroupMbidByMasterDiscogsId(1234);
      expect(result).toBeNull();
    });

    it('throws on non-404 errors so the enricher can count them as failed', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));
      await expect(client.getReleaseGroupMbidByMasterDiscogsId(1)).rejects.toThrow(
        'Network failure',
      );
    });

    it('throws after exhausting all retries on a persistent 503 (4 attempts = 3 retries)', async () => {
      fetchSpy.mockResolvedValue(makeErrorResponse(503, 'Service Unavailable'));

      await expect(client.getReleaseGroupMbidByMasterDiscogsId(1)).rejects.toThrow(
        'exceeded max retries',
      );
      // Pins MAX_RETRIES=3 wiring; the loop mechanics live in rate-limited-fetch.test.ts.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
  });

  // -------------------------------------------------------------------------
  // getReleaseEventsByReleaseGroupMbid
  // -------------------------------------------------------------------------
  describe('getReleaseEventsByReleaseGroupMbid', () => {
    it('returns release events extracted from a single page', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          'release-count': 1,
          releases: [
            {
              id: 'rel-001',
              'release-events': [
                { date: '1969-09-26', area: { 'iso-3166-1-codes': ['GB'] } },
                { date: '1969-10-01', area: { 'iso-3166-1-codes': ['US'] } },
              ],
              media: [{ format: 'Vinyl' }],
            },
          ],
        }),
      );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');

      // release-events are returned by default; `inc=release-events` is rejected by the
      // browse endpoint. inc=media supplies formats. Guards the latent #183 bug.
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('inc=media');
      expect(url).not.toContain('inc=release-events');

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        mbReleaseId: 'rel-001',
        countryCode: 'GB',
        date: '1969-09-26',
        formats: ['Vinyl'],
      });
      expect(events[1]).toEqual({
        mbReleaseId: 'rel-001',
        countryCode: 'US',
        date: '1969-10-01',
        formats: ['Vinyl'],
      });
    });

    it('paginates until all releases are collected', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          makeOkResponse({
            'release-count': 2,
            releases: [
              {
                id: 'rel-001',
                'release-events': [{ date: '1969', area: { 'iso-3166-1-codes': ['GB'] } }],
                media: [],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          makeOkResponse({
            'release-count': 2,
            releases: [
              {
                id: 'rel-002',
                'release-events': [{ date: '1970', area: { 'iso-3166-1-codes': ['US'] } }],
                media: [],
              },
            ],
          }),
        );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(2);
      expect(events[0]?.countryCode).toBe('GB');
      expect(events[1]?.countryCode).toBe('US');
    });

    it('filters out events where both countryCode and date are null', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          'release-count': 1,
          releases: [
            {
              id: 'rel-001',
              'release-events': [
                { date: null, area: null },
                { date: '1987', area: { 'iso-3166-1-codes': ['GB'] } },
              ],
              media: [],
            },
          ],
        }),
      );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');

      expect(events).toHaveLength(1);
      expect(events[0]?.date).toBe('1987');
    });

    it('stores events with a date but no country code (countryCode null)', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          'release-count': 1,
          releases: [
            {
              id: 'rel-001',
              'release-events': [{ date: '2009', area: null }],
              media: [],
            },
          ],
        }),
      );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        mbReleaseId: 'rel-001',
        countryCode: null,
        date: '2009',
        formats: [],
      });
    });

    it('deduplicates formats from media', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          'release-count': 1,
          releases: [
            {
              id: 'rel-001',
              'release-events': [{ date: '1969', area: { 'iso-3166-1-codes': ['US'] } }],
              media: [{ format: 'Vinyl' }, { format: 'Vinyl' }, { format: 'CD' }],
            },
          ],
        }),
      );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');

      expect(events[0]?.formats).toEqual(['Vinyl', 'CD']);
    });

    it('stores partial dates as strings without modification', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          'release-count': 1,
          releases: [
            {
              id: 'rel-001',
              'release-events': [{ date: '1969', area: { 'iso-3166-1-codes': ['GB'] } }],
              media: [],
            },
          ],
        }),
      );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');

      expect(events[0]?.date).toBe('1969');
    });

    it('returns empty array when release has no release-events', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          'release-count': 1,
          releases: [{ id: 'rel-001', media: [] }],
        }),
      );

      const events = await client.getReleaseEventsByReleaseGroupMbid('rg-mbid');
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getReleaseMbidByDiscogsReleaseId
  // -------------------------------------------------------------------------
  describe('getReleaseMbidByDiscogsReleaseId', () => {
    it('returns the release MBID when a discogs relation is found', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'url-uuid',
          resource: 'https://www.discogs.com/release/567',
          relations: [{ type: 'discogs', direction: 'backward', release: { id: 'rel-mbid-xyz' } }],
        }),
      );

      const result = await client.getReleaseMbidByDiscogsReleaseId(567);

      expect(result).toBe('rel-mbid-xyz');
      const urlCall = fetchSpy.mock.calls[0]?.[0] as string;
      expect(urlCall).toContain('/url');
      expect(urlCall).toContain(encodeURIComponent('https://www.discogs.com/release/567'));
      expect(urlCall).toContain('release-rels');
    });

    it('returns null when the release is not in MusicBrainz (404)', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));
      const result = await client.getReleaseMbidByDiscogsReleaseId(9999);
      expect(result).toBeNull();
    });

    it('returns null when relations list has no release entry', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'url-uuid',
          resource: 'https://www.discogs.com/release/567',
          relations: [{ type: 'artist', direction: 'backward', artist: { id: 'a1', name: 'X' } }],
        }),
      );
      const result = await client.getReleaseMbidByDiscogsReleaseId(567);
      expect(result).toBeNull();
    });

    it('throws on non-404 errors so the enricher can count them as failed', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));
      await expect(client.getReleaseMbidByDiscogsReleaseId(1)).rejects.toThrow('Network failure');
    });
  });

  // -------------------------------------------------------------------------
  // getRecordingsByReleaseMbid
  // -------------------------------------------------------------------------
  describe('getRecordingsByReleaseMbid', () => {
    it('flattens media into an ordinal-ordered tracklist', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'rel-mbid',
          media: [
            {
              tracks: [
                {
                  id: 't1',
                  title: 'Side A Track',
                  length: 215000,
                  recording: { id: 'rec-1', title: 'Side A Track', isrcs: ['GBABC1234567'] },
                },
              ],
            },
            {
              tracks: [
                {
                  id: 't2',
                  title: 'Side B Track',
                  length: 180000,
                  recording: { id: 'rec-2', title: 'Side B Track', isrcs: [] },
                },
              ],
            },
          ],
        }),
      );

      const tracks = await client.getRecordingsByReleaseMbid('rel-mbid');

      const endpoint = fetchSpy.mock.calls[0]?.[0] as string;
      expect(endpoint).toContain('/release/rel-mbid');
      expect(endpoint).toContain('recordings');
      expect(tracks).toEqual([
        {
          position: 1,
          title: 'Side A Track',
          lengthSeconds: 215,
          recordingMbid: 'rec-1',
          isrc: 'GBABC1234567',
        },
        {
          position: 2,
          title: 'Side B Track',
          lengthSeconds: 180,
          recordingMbid: 'rec-2',
          isrc: null,
        },
      ]);
    });

    it('falls back to recording length when the track has none', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'rel-mbid',
          media: [
            {
              tracks: [
                {
                  id: 't1',
                  title: 'Track',
                  recording: { id: 'rec-1', title: 'Track', length: 200000 },
                },
              ],
            },
          ],
        }),
      );

      const tracks = await client.getRecordingsByReleaseMbid('rel-mbid');
      expect(tracks[0]?.lengthSeconds).toBe(200);
    });

    it('returns lengthSeconds null when neither track nor recording has a length', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          id: 'rel-mbid',
          media: [
            { tracks: [{ id: 't1', title: 'Track', recording: { id: 'rec-1', title: 'Track' } }] },
          ],
        }),
      );

      const tracks = await client.getRecordingsByReleaseMbid('rel-mbid');
      expect(tracks[0]?.lengthSeconds).toBeNull();
    });

    it('returns an empty array when the release has no media', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse({ id: 'rel-mbid' }));
      const tracks = await client.getRecordingsByReleaseMbid('rel-mbid');
      expect(tracks).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // searchRecording
  // -------------------------------------------------------------------------
  describe('searchRecording', () => {
    it('returns a match when the top result scores at least 90', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({
          recordings: [{ id: 'rec-mbid', score: 100, title: 'Song', isrcs: ['USABC1234567'] }],
        }),
      );

      const result = await client.searchRecording('Song', 'Artist', 200);

      expect(result).toEqual({ recordingMbid: 'rec-mbid', isrc: 'USABC1234567' });
      const query = decodeURIComponent(fetchSpy.mock.calls[0]?.[0] as string);
      expect(query).toContain('recording:"Song"');
      expect(query).toContain('artist:"Artist"');
      expect(query).toContain('dur:[198000 TO 202000]');
    });

    it('omits the duration filter when duration is null', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({ recordings: [{ id: 'rec', score: 95, title: 'Song' }] }),
      );

      await client.searchRecording('Song', 'Artist', null);

      const query = decodeURIComponent(fetchSpy.mock.calls[0]?.[0] as string);
      expect(query).not.toContain('dur:');
    });

    it('returns null when the top result scores below 90', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({ recordings: [{ id: 'rec', score: 60, title: 'Song' }] }),
      );
      const result = await client.searchRecording('Song', 'Artist', null);
      expect(result).toBeNull();
    });

    it('returns null when there are no recordings', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse({ recordings: [] }));
      const result = await client.searchRecording('Song', 'Artist', null);
      expect(result).toBeNull();
    });

    it('returns null without a request when title or artist is empty', async () => {
      const result = await client.searchRecording('   ', 'Artist', null);
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null (does not throw) on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('timeout'));
      const result = await client.searchRecording('Song', 'Artist', null);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // fetchWithBackoff — transient network errors
  // -------------------------------------------------------------------------
  describe('transient network-error retry', () => {
    it('retries a "fetch failed" TypeError and succeeds on the next attempt', async () => {
      fetchSpy
        .mockRejectedValueOnce(makeNetworkError('fetch failed'))
        .mockResolvedValueOnce(makeOkResponse(mbReleaseRelationResponse('rel-mbid-xyz')));

      const result = await client.getReleaseMbidByDiscogsReleaseId(567);

      expect(result).toBe('rel-mbid-xyz');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('retries when the transient code is nested in error.cause', async () => {
      fetchSpy
        .mockRejectedValueOnce(makeNetworkError('connection error', 'ECONNRESET', 'cause'))
        .mockResolvedValueOnce(makeOkResponse(mbReleaseRelationResponse('rel-mbid-cause')));

      const result = await client.getReleaseMbidByDiscogsReleaseId(567);

      expect(result).toBe('rel-mbid-cause');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('retries when the transient code is set directly on the error', async () => {
      fetchSpy
        .mockRejectedValueOnce(makeNetworkError('socket hang up', 'ETIMEDOUT', 'self'))
        .mockResolvedValueOnce(makeOkResponse(mbReleaseRelationResponse('rel-mbid-direct')));

      const result = await client.getReleaseMbidByDiscogsReleaseId(567);

      expect(result).toBe('rel-mbid-direct');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('gives up after MAX_RETRIES and rethrows the original network error', async () => {
      fetchSpy.mockRejectedValue(makeNetworkError('fetch failed'));

      await expect(client.getReleaseMbidByDiscogsReleaseId(567)).rejects.toThrow('fetch failed');
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('does not retry a non-Error rejection — rethrows immediately', async () => {
      fetchSpy.mockRejectedValueOnce('weird');

      await expect(client.getReleaseMbidByDiscogsReleaseId(567)).rejects.toBe('weird');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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
