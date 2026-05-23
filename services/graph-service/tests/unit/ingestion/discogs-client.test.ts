import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
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

describe('DiscogsClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: DiscogsClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new DiscogsClient({
      token: 'test-token',
      userAgent: 'liner-notes/test',
      delayMs: 0, // no per-request delay in unit tests
      backoffBaseMs: 0, // no 429 backoff delay in unit tests
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
  // getMaster
  // -------------------------------------------------------------------------
  describe('getMaster', () => {
    it('calls the correct master URL and returns parsed data', async () => {
      const fakeData = { id: 4242, title: 'Kind of Blue' };
      fetchSpy.mockResolvedValueOnce(makeOkResponse(fakeData));

      const result = await client.getMaster(4242);

      expect(result).toEqual(fakeData);
      expect(fetchSpy.mock.calls[0]?.[0]).toContain('/masters/4242');
    });
  });

  // -------------------------------------------------------------------------
  // getMasterVersions
  // -------------------------------------------------------------------------
  describe('getMasterVersions', () => {
    it('calls the correct versions URL with default page/perPage', async () => {
      const fakeData = { versions: [], pagination: {} };
      fetchSpy.mockResolvedValueOnce(makeOkResponse(fakeData));

      const result = await client.getMasterVersions(4242);

      expect(result).toEqual(fakeData);
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('/masters/4242/versions');
      expect(url).toContain('page=1');
      expect(url).toContain('per_page=100');
    });
  });

  // -------------------------------------------------------------------------
  // getArtist
  // -------------------------------------------------------------------------
  describe('getArtist', () => {
    it('calls the correct artist URL and returns parsed data', async () => {
      const fakeData = { id: 123, name: 'Miles Davis' };
      fetchSpy.mockResolvedValueOnce(makeOkResponse(fakeData));

      const result = await client.getArtist(123);

      expect(result).toEqual(fakeData);
      expect(fetchSpy.mock.calls[0]?.[0]).toContain('/artists/123');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('throws on non-429 HTTP errors and does not retry', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));

      await expect(client.getRelease(99999999)).rejects.toThrow('404');
      // Non-429 errors must fail fast — no retry loop, no exponential backoff.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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

    it('applies exponential backoff: each retry waits roughly double the previous', async () => {
      // Use a non-zero backoffBaseMs so the doubling is observable. With
      // backoffBaseMs=0 (the default for other tests) the schedule degenerates
      // to 0,0,0,... and there is nothing to assert. Pass a stub logger so the
      // 429 warn() calls do not pollute test stdout.
      const backoffClient = new DiscogsClient({
        token: 'test-token',
        userAgent: 'liner-notes/test',
        delayMs: 0,
        backoffBaseMs: 100,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn, ..._args) => {
          (fn as () => void)();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      // try/finally guarantees the global setTimeout spy is restored even if
      // an assertion below throws — a leaked spy would corrupt later tests.
      try {
        fetchSpy
          .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
          .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
          .mockResolvedValueOnce(makeOkResponse(release13570466));

        await backoffClient.getRelease(13570466);

        // The first two setTimeout calls are the 429 backoffs (the third would
        // be the post-success delayMs sleep, which is 0). Second wait must be
        // ~2x the first.
        const firstDelay = setTimeoutSpy.mock.calls[0]?.[1] as number;
        const secondDelay = setTimeoutSpy.mock.calls[1]?.[1] as number;
        expect(firstDelay).toBe(100);
        expect(secondDelay).toBe(200);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('honours the Retry-After header: waits at least the server-specified duration', async () => {
      // Intercept setTimeout so the test doesn't actually sleep, but still capture the delay.
      const setTimeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn, ..._args) => {
          (fn as () => void)();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests', 2)) // Retry-After: 2s
        .mockResolvedValueOnce(makeOkResponse(release13570466));

      await client.getRelease(13570466);

      // First setTimeout call is the 429 backoff — should be at least 2000ms from Retry-After.
      const firstDelay = setTimeoutSpy.mock.calls[0]?.[1] ?? 0;
      expect(firstDelay).toBeGreaterThanOrEqual(2_000);

      setTimeoutSpy.mockRestore();
    });
  });
});
