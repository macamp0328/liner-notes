import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { WikidataClient } from '../../../src/ingestion/wikidata-client.js';

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
});
