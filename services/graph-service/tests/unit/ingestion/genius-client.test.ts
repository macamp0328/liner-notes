import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  GeniusClient,
  GeniusHttpError,
  isExpectedGeniusBlock,
  buildGeniusClientFromEnv,
} from '../../../src/ingestion/genius-client.js';
import { RetriesExhaustedError } from '../../../src/ingestion/rate-limited-fetch.js';
import geniusSearchHit from '../../fixtures/genius-search-hit.json' with { type: 'json' };

function makeJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

function makeHtmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(html),
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

const LYRICS_HTML = '<div data-lyrics-container="true">Hello<br/>World</div>';

describe('GeniusClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: GeniusClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new GeniusClient({
      token: 'test-token',
      userAgent: 'Mozilla/5.0 (test-browser)',
      delayMs: 0,
      backoffBaseMs: 0,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('searches then scrapes the page and returns extracted lyrics', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeJsonResponse(geniusSearchHit))
      .mockResolvedValueOnce(makeHtmlResponse(LYRICS_HTML));

    const result = await client.getLyrics('Test Artist', 'Song Title');

    expect(result).toBe('Hello\nWorld');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain('api.genius.com/search');
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://genius.com/Test-artist-song-title-lyrics');
  });

  it('sends Bearer auth + browser UA on the search call and UA on the page call', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeJsonResponse(geniusSearchHit))
      .mockResolvedValueOnce(makeHtmlResponse(LYRICS_HTML));

    await client.getLyrics('Test Artist', 'Song Title');

    const searchHeaders = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(searchHeaders['Authorization']).toBe('Bearer test-token');
    expect(searchHeaders['User-Agent']).toBe('Mozilla/5.0 (test-browser)');
    expect(searchHeaders['Accept']).toBe('application/json');

    const pageHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(pageHeaders['User-Agent']).toBe('Mozilla/5.0 (test-browser)');
    expect(pageHeaders['Accept']).toContain('text/html');
  });

  it('returns null when search has no hits (no page fetch)', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse({ response: { hits: [] } }));

    expect(await client.getLyrics('A', 'B')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns null when the first hit is not a song', async () => {
    const articleHit = {
      response: {
        hits: [
          {
            type: 'article',
            result: { id: 1, url: 'https://genius.com/x', primary_artist: { name: 'Test Artist' } },
          },
        ],
      },
    };
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(articleHit));

    expect(await client.getLyrics('Test Artist', 'B')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns null when the primary artist does not fuzzy-match', async () => {
    const wrongArtist = {
      response: {
        hits: [
          {
            type: 'song',
            result: {
              id: 1,
              url: 'https://genius.com/x',
              primary_artist: { name: 'Completely Different Artist' },
            },
          },
        ],
      },
    };
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(wrongArtist));

    expect(await client.getLyrics('Test Artist', 'B')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns null when the page yields no valid lyrics', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeJsonResponse(geniusSearchHit))
      .mockResolvedValueOnce(makeHtmlResponse('<html><body>nothing here</body></html>'));

    expect(await client.getLyrics('Test Artist', 'Song Title')).toBeNull();
  });

  it('throws an expected GeniusHttpError on a 403 bot-block (not retried)', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(403));

    const err = await client.getLyrics('A', 'B').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GeniusHttpError);
    expect((err as GeniusHttpError).status).toBe(403);
    expect((err as GeniusHttpError).phase).toBe('search');
    expect(isExpectedGeniusBlock(err)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce(); // 403 is not retried
  });

  it('throws a GeniusHttpError on a 403 on the page request', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeJsonResponse(geniusSearchHit))
      .mockResolvedValueOnce(makeErrorResponse(403));

    const err = await client.getLyrics('Test Artist', 'Song Title').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GeniusHttpError);
    expect((err as GeniusHttpError).phase).toBe('page');
    expect(isExpectedGeniusBlock(err)).toBe(true);
  });

  it('retries a 5xx then exhausts to RetriesExhaustedError (not expected)', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(500));

    const err = await client.getLyrics('A', 'B').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetriesExhaustedError);
    expect(isExpectedGeniusBlock(err)).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 3 retries + initial
  });
});

describe('buildGeniusClientFromEnv', () => {
  const saved = { token: process.env['GENIUS_TOKEN'], ua: process.env['GENIUS_USER_AGENT'] };

  afterEach(() => {
    if (saved.token === undefined) delete process.env['GENIUS_TOKEN'];
    else process.env['GENIUS_TOKEN'] = saved.token;
    if (saved.ua === undefined) delete process.env['GENIUS_USER_AGENT'];
    else process.env['GENIUS_USER_AGENT'] = saved.ua;
  });

  it('returns null when GENIUS_TOKEN is unset (prod path)', () => {
    delete process.env['GENIUS_TOKEN'];
    expect(buildGeniusClientFromEnv()).toBeNull();
  });

  it('builds a client when GENIUS_TOKEN is set', () => {
    process.env['GENIUS_TOKEN'] = 'tok';
    expect(buildGeniusClientFromEnv()).toBeInstanceOf(GeniusClient);
  });
});
