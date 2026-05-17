import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  WikidataClient,
  buildWikidataClientFromEnv,
} from '../../../src/ingestion/wikidata-client.js';

function makeSparqlResponse(countryCode?: string): unknown {
  return {
    results: {
      bindings:
        countryCode !== undefined ? [{ countryCode: { type: 'literal', value: countryCode } }] : [],
    },
  };
}

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, headers?: Record<string, string>): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: vi.fn().mockResolvedValue({}),
    headers: {
      get: (name: string) => headers?.[name] ?? null,
    },
  } as unknown as Response;
}

describe('WikidataClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: WikidataClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new WikidataClient({ userAgent: 'liner-notes/test', delayMs: 0, backoffBaseMs: 0 });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns ISO country code when Wikidata has the artist', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('GB')));

    const result = await client.getCountryByDiscogsId(470470);

    expect(result).toBe('GB');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('query.wikidata.org/sparql');
    expect(url).toContain('470470');
  });

  it('returns null when artist is not in Wikidata (empty bindings)', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse()));
    const result = await client.getCountryByDiscogsId(999);
    expect(result).toBeNull();
  });

  it('trims whitespace from country code', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse(' US ')));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBe('US');
  });

  it('returns null on 404 without retrying', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(404));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on the next attempt', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('FR')));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBe('FR');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 and succeeds on the next attempt', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(502))
      .mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('DE')));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBe('DE');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 and succeeds on the next attempt', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('JP')));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBe('JP');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting all retries on persistent 502', async () => {
    // MAX_RETRIES=3: attempts 0,1,2 retry; attempt 3 breaks immediately without a 4th fetch
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(502))
      .mockResolvedValueOnce(makeErrorResponse(502))
      .mockResolvedValueOnce(makeErrorResponse(502))
      .mockResolvedValueOnce(makeErrorResponse(502));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('honors Retry-After header on 429 when it exceeds backoff', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.fn();
    const clientWithLogger = new WikidataClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
    });
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429, { 'Retry-After': '5' }))
      .mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('BR')));
    const resultPromise = clientWithLogger.getCountryByDiscogsId(1);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toBe('BR');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('5000ms'));
    vi.useRealTimers();
  });

  it('returns null on network error (does not throw)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network failure'));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBeNull();
  });

  it('sends the configured User-Agent header', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('DE')));
    await client.getCountryByDiscogsId(1);
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('liner-notes/test');
  });

  it('sends Accept: application/sparql-results+json', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('CA')));
    await client.getCountryByDiscogsId(1);
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/sparql-results+json');
  });

  // ---------------------------------------------------------------------------
  // getCountryByWikipediaTitle / getCountryByWikipediaUrl
  // ---------------------------------------------------------------------------

  describe('getCountryByWikipediaTitle', () => {
    it('returns ISO code when Wikipedia article resolves via Wikidata', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('IT')));

      const result = await client.getCountryByWikipediaTitle('Pino Palladino');

      expect(result).toBe('IT');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('query.wikidata.org/sparql');
      expect(url).toContain('Pino_Palladino');
      expect(url).toContain('schema%3Aabout');
    });

    it('returns null on empty SPARQL bindings', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse()));
      const result = await client.getCountryByWikipediaTitle('Unknown Artist');
      expect(result).toBeNull();
    });

    it('retries on 429 and succeeds', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(429))
        .mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('SE')));
      const result = await client.getCountryByWikipediaTitle('ABBA');
      expect(result).toBe('SE');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('retries on 502 and succeeds', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeErrorResponse(502))
        .mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('NO')));
      const result = await client.getCountryByWikipediaTitle('Jan Garbarek');
      expect(result).toBe('NO');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns null on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network failure'));
      const result = await client.getCountryByWikipediaTitle('Some Artist');
      expect(result).toBeNull();
    });

    it('encodes spaces as underscores in the SPARQL URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('GB')));
      await client.getCountryByWikipediaTitle('John Paul Jones');
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain('John_Paul_Jones');
      expect(url).not.toContain('John Paul Jones');
    });
  });

  describe('getCountryByWikipediaUrl', () => {
    it('parses English Wikipedia URL and returns country', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('GB')));

      const result = await client.getCountryByWikipediaUrl(
        'https://en.wikipedia.org/wiki/Pino_Palladino',
      );

      expect(result).toBe('GB');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null for non-English Wikipedia URLs without making a network call', async () => {
      const result = await client.getCountryByWikipediaUrl(
        'https://fr.wikipedia.org/wiki/Miles_Davis',
      );
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null for non-Wikipedia URLs without making a network call', async () => {
      const result = await client.getCountryByWikipediaUrl('https://www.discogs.com/artist/12345');
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('preserves percent-encoded characters in Wikipedia URL path directly in SPARQL IRI', async () => {
      fetchSpy.mockResolvedValueOnce(makeOkResponse(makeSparqlResponse('IS')));

      await client.getCountryByWikipediaUrl('https://en.wikipedia.org/wiki/Bj%C3%B6rk');

      // The raw path 'Bj%C3%B6rk' is embedded in the SPARQL query as-is, then the whole query
      // is encodeURIComponent'd — so '%' becomes '%25', leaving 'Bj%25C3%25B6rk' in the fetch URL.
      const rawUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(rawUrl).toContain('Bj%25C3%25B6rk');
    });
  });
});

describe('buildWikidataClientFromEnv', () => {
  const originalMb = process.env['MUSICBRAINZ_USER_AGENT'];
  const originalDiscogs = process.env['DISCOGS_USER_AGENT'];
  afterEach(() => {
    if (originalMb === undefined) {
      delete process.env['MUSICBRAINZ_USER_AGENT'];
    } else {
      process.env['MUSICBRAINZ_USER_AGENT'] = originalMb;
    }
    if (originalDiscogs === undefined) {
      delete process.env['DISCOGS_USER_AGENT'];
    } else {
      process.env['DISCOGS_USER_AGENT'] = originalDiscogs;
    }
  });

  it('returns null when neither env var is set', () => {
    delete process.env['MUSICBRAINZ_USER_AGENT'];
    delete process.env['DISCOGS_USER_AGENT'];
    expect(buildWikidataClientFromEnv()).toBeNull();
  });

  it('returns a WikidataClient when MUSICBRAINZ_USER_AGENT is set', () => {
    process.env['MUSICBRAINZ_USER_AGENT'] = 'test-agent/1.0';
    expect(buildWikidataClientFromEnv()).toBeInstanceOf(WikidataClient);
  });

  it('returns a WikidataClient when a logger is supplied', () => {
    process.env['MUSICBRAINZ_USER_AGENT'] = 'test-agent/1.0';
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    expect(buildWikidataClientFromEnv(logger)).toBeInstanceOf(WikidataClient);
  });
});
