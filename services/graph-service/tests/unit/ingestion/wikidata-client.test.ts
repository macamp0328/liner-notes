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

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

describe('WikidataClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: WikidataClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new WikidataClient({ userAgent: 'liner-notes/test', delayMs: 0 });
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

  it('returns null on 404', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(404));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBeNull();
  });

  it('returns null on 429 (rate limit)', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(429));
    const result = await client.getCountryByDiscogsId(1);
    expect(result).toBeNull();
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
