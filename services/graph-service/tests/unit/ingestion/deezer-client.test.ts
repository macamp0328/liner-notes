import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { DeezerClient, buildDeezerClientFromEnv } from '../../../src/ingestion/deezer-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function make404Response(): Response {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

function makeTrackResponse(bpm: number, gain: number) {
  return { id: 1234567, bpm, gain };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  // ── getTrackByIsrc ─────────────────────────────────────────────────────────

  it('encodes the ISRC into the URL and returns bpm and gain', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTrackResponse(128.5, -8.3)));

    const result = await client.getTrackByIsrc('USUM71703861');

    expect(result).toEqual({ bpm: 128.5, gain: -8.3 });
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('isrc:USUM71703861');
  });

  it('returns null on 404 (ISRC not in Deezer catalog)', async () => {
    fetchSpy.mockResolvedValueOnce(make404Response());
    const result = await client.getTrackByIsrc('UNKNOWN00001');
    expect(result).toBeNull();
  });

  it('returns null when Deezer responds with an error object in the body', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ error: { type: 'DataException', message: 'no data', code: 800 } }),
    );
    const result = await client.getTrackByIsrc('USUM00000000');
    expect(result).toBeNull();
  });

  it('returns null when response has no id field', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ bpm: 120, gain: -5 }));
    const result = await client.getTrackByIsrc('NOID00000000');
    expect(result).toBeNull();
  });

  it('coerces bpm=0 to null and returns null when both fields are null', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTrackResponse(0, 0)));
    const result = await client.getTrackByIsrc('ZEROS0000001');
    expect(result).toBeNull();
  });

  it('coerces only bpm=0 to null but preserves non-zero gain', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTrackResponse(0, -6.5)));
    const result = await client.getTrackByIsrc('MIXED0000001');
    expect(result).toEqual({ bpm: null, gain: -6.5 });
  });

  it('coerces only gain=0 to null but preserves non-zero bpm', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTrackResponse(120.0, 0)));
    const result = await client.getTrackByIsrc('MIXED0000002');
    expect(result).toEqual({ bpm: 120.0, gain: null });
  });

  // ── rate-limit backoff ─────────────────────────────────────────────────────

  it('retries on 429 and succeeds after backoff', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
      .mockResolvedValueOnce(makeOkResponse(makeTrackResponse(110.0, -7.0)));

    const result = await client.getTrackByIsrc('RETRY0000001');

    expect(result).toEqual({ bpm: 110.0, gain: -7.0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 503', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(makeOkResponse(makeTrackResponse(90.0, -5.0)));

    const result = await client.getTrackByIsrc('RETRY5030001');
    expect(result).toEqual({ bpm: 90.0, gain: -5.0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After header (in seconds) on 429', async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests', 2))
      .mockResolvedValueOnce(makeOkResponse(makeTrackResponse(100.0, -4.0)));

    const promise = client.getTrackByIsrc('RETRYAFTER01');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ bpm: 100.0, gain: -4.0 });
    vi.useRealTimers();
  });

  it('throws on a non-ok status other than 404/429/503', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500, 'Internal Server Error'));
    await expect(client.getTrackByIsrc('ERROR0000001')).rejects.toThrow(/500/);
  });

  it('throws after exhausting max retries on repeated 429', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(429, 'Too Many Requests'));
    await expect(client.getTrackByIsrc('EXHAUST00001')).rejects.toThrow(/exceeded max retries/);
  });

  // ── buildDeezerClientFromEnv ───────────────────────────────────────────────

  it('always returns a DeezerClient (no env gate required)', () => {
    const c = buildDeezerClientFromEnv();
    expect(c).toBeInstanceOf(DeezerClient);
  });
});
