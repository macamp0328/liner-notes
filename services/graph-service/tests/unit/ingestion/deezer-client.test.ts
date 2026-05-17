import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { DeezerClient, buildDeezerClientFromEnv } from '../../../src/ingestion/deezer-client.js';

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

const deezerTrackResponse = (bpm: number, gain: number) => ({
  id: 123,
  title: 'Test Track',
  bpm,
  gain,
});

describe('DeezerClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: DeezerClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new DeezerClient({ delayMs: 0, backoffBaseMs: 0 });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('getTrackByIsrc', () => {
    it('returns bpm and gain from a successful lookup', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(deezerTrackResponse(128.5, -6.2)));

      const result = await client.getTrackByIsrc('USUM71900001');

      expect(result).toEqual({ bpm: 128.5, gain: -6.2 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('/track/isrc:USUM71900001');
    });

    it('treats bpm of 0 as null', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(deezerTrackResponse(0, -6.2)));
      const result = await client.getTrackByIsrc('USUM71900001');
      expect(result).toEqual({ bpm: null, gain: -6.2 });
    });

    it('treats gain of 0 as null', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(deezerTrackResponse(128.5, 0)));
      const result = await client.getTrackByIsrc('USUM71900001');
      expect(result).toEqual({ bpm: 128.5, gain: null });
    });

    it('returns null when both bpm and gain are 0', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(deezerTrackResponse(0, 0)));
      const result = await client.getTrackByIsrc('USUM71900001');
      expect(result).toBeNull();
    });

    it('returns null on 404', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));
      const result = await client.getTrackByIsrc('UNKNOWN-ISRC');
      expect(result).toBeNull();
    });

    it('returns null when Deezer returns an error object (ISRC not found)', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeOkResponse({ error: { type: 'DataException', message: 'no data', code: 800 } }),
      );
      const result = await client.getTrackByIsrc('UNKNOWN-ISRC');
      expect(result).toBeNull();
    });

    it('retries on 429 and resolves on second attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
        .mockResolvedValueOnce(makeOkResponse(deezerTrackResponse(120.0, -5.0)));

      const result = await client.getTrackByIsrc('USUM71900001');

      expect(result).toEqual({ bpm: 120.0, gain: -5.0 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('respects Retry-After header on 429', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests', 1))
        .mockResolvedValueOnce(makeOkResponse(deezerTrackResponse(100.0, -3.0)));

      const result = await client.getTrackByIsrc('USUM71900001');
      expect(result).toEqual({ bpm: 100.0, gain: -3.0 });
    });

    it('throws on a non-ok, non-429 response', async () => {
      fetchSpy.mockResolvedValueOnce(makeErrorResponse(500, 'Internal Server Error'));
      await expect(client.getTrackByIsrc('USUM71900001')).rejects.toThrow('500');
    });

    it('throws after exceeding max retries', async () => {
      fetchSpy.mockResolvedValue(makeErrorResponse(429, 'Too Many Requests'));
      await expect(client.getTrackByIsrc('USUM71900001')).rejects.toThrow('exceeded max retries');
    });
  });
});

describe('buildDeezerClientFromEnv', () => {
  it('returns a DeezerClient instance', () => {
    const client = buildDeezerClientFromEnv();
    expect(client).toBeInstanceOf(DeezerClient);
  });

  it('returns a DeezerClient when a logger is supplied', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const client = buildDeezerClientFromEnv(logger);
    expect(client).toBeInstanceOf(DeezerClient);
  });
});
