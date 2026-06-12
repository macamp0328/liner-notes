import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { LrclibClient, buildLrclibClientFromEnv } from '../../../src/ingestion/lrclib-client.js';
import { RetriesExhaustedError } from '../../../src/ingestion/rate-limited-fetch.js';
import { snapshotEnv } from '../../helpers/env.js';

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, retryAfterSecs?: number): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    headers: {
      get: (name: string) =>
        name === 'Retry-After' && retryAfterSecs !== undefined ? String(retryAfterSecs) : null,
    },
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

/** Build a transient network-level error like undici throws, with the code on `.cause`. */
function makeNetworkError(message: string, code: string): Error {
  const err = new TypeError(message);
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error(message), { code });
  return err;
}

describe('LrclibClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: LrclibClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new LrclibClient({
      userAgent: 'liner-notes/test',
      delayMs: 0, // no per-request delay in unit tests
      backoffBaseMs: 0, // no retry backoff delay in unit tests
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('calls the LRCLIB get endpoint with track_name and artist_name', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ plainLyrics: 'la la la' }));

    const result = await client.getLyrics('Test Artist', 'Song Title');

    expect(result).toEqual({
      lyrics: 'la la la',
      instrumental: false,
      matchedTitle: null,
      matchedArtist: null,
      matchedDurationSeconds: null,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('lrclib.net/api/get');
    expect(url).toContain('track_name=Song+Title');
    expect(url).toContain('artist_name=Test+Artist');
  });

  it('surfaces the matched title/artist/duration LRCLIB echoes back (#248)', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({
        plainLyrics: 'la la la',
        trackName: 'So What',
        artistName: 'Miles Davis',
        duration: 545,
      }),
    );

    const result = await client.getLyrics('Miles Davis', 'So What');

    expect(result).toEqual({
      lyrics: 'la la la',
      instrumental: false,
      matchedTitle: 'So What',
      matchedArtist: 'Miles Davis',
      matchedDurationSeconds: 545,
    });
  });

  it('reports the authoritative instrumental flag (#246)', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ instrumental: true }));

    const result = await client.getLyrics('A', 'B');

    expect(result).toEqual({
      lyrics: null,
      instrumental: true,
      matchedTitle: null,
      matchedArtist: null,
      matchedDurationSeconds: null,
    });
  });

  it('sends an identifying User-Agent header', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ plainLyrics: 'x' }));

    await client.getLyrics('A', 'B');

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('liner-notes/test');
  });

  it('returns null on a 404 (no match)', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(404));

    const result = await client.getLyrics('A', 'B');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce(); // 404 is not retried
  });

  it('returns lyrics:null (not a top-level null) when the 200 response has no plainLyrics', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ plainLyrics: null }));

    expect(await client.getLyrics('A', 'B')).toEqual({
      lyrics: null,
      instrumental: false,
      matchedTitle: null,
      matchedArtist: null,
      matchedDurationSeconds: null,
    });
  });

  it('retries a transient 5xx and then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(504))
      .mockResolvedValueOnce(makeOkResponse({ plainLyrics: 'recovered' }));

    const result = await client.getLyrics('A', 'B');

    expect(result).toEqual({
      lyrics: 'recovered',
      instrumental: false,
      matchedTitle: null,
      matchedArtist: null,
      matchedDurationSeconds: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network error and then succeeds', async () => {
    fetchSpy
      .mockRejectedValueOnce(makeNetworkError('socket hang up', 'ECONNRESET'))
      .mockResolvedValueOnce(makeOkResponse({ plainLyrics: 'ok' }));

    const result = await client.getLyrics('A', 'B');

    expect(result).toEqual({
      lyrics: 'ok',
      instrumental: false,
      matchedTitle: null,
      matchedArtist: null,
      matchedDurationSeconds: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws RetriesExhaustedError when a retryable status never recovers', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(503));

    await expect(client.getLyrics('A', 'B')).rejects.toBeInstanceOf(RetriesExhaustedError);
    // maxRetries (3) + 1 initial attempt
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('throws on a non-404, non-retryable error status without retrying', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(400));

    await expect(client.getLyrics('A', 'B')).rejects.toThrow('LRCLIB API error 400');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('buildLrclibClientFromEnv', () => {
  const saved = {
    ua: process.env['LRCLIB_USER_AGENT'],
    delay: process.env['LRCLIB_REQUEST_DELAY_MS'],
  };
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    delete process.env['LRCLIB_USER_AGENT'];
    delete process.env['LRCLIB_REQUEST_DELAY_MS'];
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (saved.ua === undefined) delete process.env['LRCLIB_USER_AGENT'];
    else process.env['LRCLIB_USER_AGENT'] = saved.ua;
    if (saved.delay === undefined) delete process.env['LRCLIB_REQUEST_DELAY_MS'];
    else process.env['LRCLIB_REQUEST_DELAY_MS'] = saved.delay;
    fetchSpy.mockRestore();
  });

  it('always builds a client (no key required) and uses the default UA', async () => {
    const client = buildLrclibClientFromEnv();
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ plainLyrics: 'y' }));

    await client.getLyrics('A', 'B');

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('liner-notes/1.0');
  });

  it('honours the LRCLIB_USER_AGENT override', async () => {
    process.env['LRCLIB_USER_AGENT'] = 'custom-agent/2.0';
    const client = buildLrclibClientFromEnv();
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ plainLyrics: 'y' }));

    await client.getLyrics('A', 'B');

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('custom-agent/2.0');
  });
});

describe('LrclibClient circuit breaker (#242)', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const env = snapshotEnv(['CIRCUIT_BREAKER_THRESHOLD', 'CIRCUIT_BREAKER_COOLDOWN_MS']);

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    env.clear();
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '2';
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    env.restore();
  });

  it('opens after consecutive fatal (403) responses, then short-circuits to null', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(403));
    const client = new LrclibClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
    });

    await expect(client.getLyrics('a', 'b')).rejects.toThrow(); // fatal 1
    await expect(client.getLyrics('a', 'b')).rejects.toThrow(); // fatal 2 → opens
    expect(client.breakerSnapshot().open).toBe(true);

    const callsBefore = fetchSpy.mock.calls.length;
    expect(await client.getLyrics('a', 'b')).toBeNull(); // short-circuit
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no network call
  });
});
