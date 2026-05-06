import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscogsClient } from '../../../src/ingestion/discogs-client.js';
import collectionPage1 from '../../fixtures/collection-page-1.json' with { type: 'json' };
import release13570466 from '../../fixtures/release-13570466.json' with { type: 'json' };

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

describe('DiscogsClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: DiscogsClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new DiscogsClient({
      token: 'test-token',
      userAgent: 'liner-notes/test',
      delayMs: 0, // no delay in unit tests
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // getCollectionReleases
  // -------------------------------------------------------------------------
  describe('getCollectionReleases', () => {
    it('calls the correct Discogs collection URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(collectionPage1));

      await client.getCollectionReleases('testuser', 1, 50);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('/users/testuser/collection/folders/0/releases');
      expect(url).toContain('page=1');
      expect(url).toContain('per_page=50');
    });

    it('includes Authorization and User-Agent headers', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(collectionPage1));

      await client.getCollectionReleases('testuser', 1, 50);

      const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Discogs token=test-token');
      expect(headers['User-Agent']).toBe('liner-notes/test');
    });

    it('returns the parsed collection page', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(collectionPage1));

      const result = await client.getCollectionReleases('testuser', 1, 50);

      expect(result.pagination.page).toBe(1);
      expect(result.releases).toHaveLength(3);
    });

    it('URL-encodes the username', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(collectionPage1));

      await client.getCollectionReleases('test user+special', 1, 50);

      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('/users/test%20user%2Bspecial/');
    });
  });

  // -------------------------------------------------------------------------
  // getRelease
  // -------------------------------------------------------------------------
  describe('getRelease', () => {
    it('calls the correct release URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(release13570466));

      await client.getRelease(13570466);

      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('/releases/13570466');
    });

    it('returns the parsed release', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(release13570466));

      const result = await client.getRelease(13570466);

      expect(result.id).toBe(13570466);
      expect(result.title).toBe('U.F.O.F.');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('throws on non-429 HTTP errors', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));

      await expect(client.getRelease(99999999)).rejects.toThrow('404');
    });

    it('retries on 429 and succeeds on next attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
        .mockResolvedValueOnce(makeOkResponse(release13570466));

      const result = await client.getRelease(13570466);

      expect(result.id).toBe(13570466);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws after exceeding max retries on persistent 429', async () => {
      // Always respond with 429
      fetchSpy.mockResolvedValue(makeErrorResponse(429, 'Too Many Requests'));

      await expect(client.getRelease(13570466)).rejects.toThrow(/exceeded max retries/);
      // Should have tried MAX_RETRIES+1 = 6 times
      expect(fetchSpy.mock.calls.length).toBe(6);
    });
  });
});
