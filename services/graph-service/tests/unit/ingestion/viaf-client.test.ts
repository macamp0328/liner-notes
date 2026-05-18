import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { VIAFClient, buildViafClientFromEnv } from '../../../src/ingestion/viaf-client.js';

function makeViafResponse(overrides?: {
  nameType?: string;
  preferredName?: string;
  nationalities?: Array<{ text: string }> | { text: string };
}): unknown {
  const nameType = overrides?.nameType ?? 'Personal';
  const preferredName = overrides?.preferredName ?? 'Carter, Ron';
  const nationalities = overrides?.nationalities ?? [{ text: 'xxu' }];

  return {
    searchRetrieveResponse: {
      records: [
        {
          record: {
            recordData: {
              nameType,
              mainHeadings: {
                data: [{ text: preferredName }],
              },
              nationalityOfEntity: {
                data: nationalities,
              },
            },
          },
        },
      ],
    },
  };
}

function makeEmptyViafResponse(): unknown {
  return { searchRetrieveResponse: { records: [] } };
}

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
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

function makeHtmlResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (name: string) => (name === 'content-type' ? 'text/html; charset=utf-8' : null),
    },
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  } as unknown as Response;
}

describe('VIAFClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: VIAFClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new VIAFClient({ userAgent: 'liner-notes/test', delayMs: 0, backoffBaseMs: 0 });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns ISO code for a valid Personal name match', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Ron Carter',
          nationalities: [{ text: 'xxu' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Ron Carter');

    expect(result).toBe('US');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('viaf.org/viaf/search');
    expect(url).toContain('Ron%20Carter');
  });

  it('returns null when nameType is not Personal', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          nameType: 'Corporate',
          preferredName: 'Berlin Philharmonic',
          nationalities: [{ text: 'gw' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Berlin Philharmonic');

    expect(result).toBeNull();
  });

  it('returns null when preferred name does not match queried name (case-insensitive)', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Brown, James',
          nationalities: [{ text: 'xxu' }],
        }),
      ),
    );

    const result = await client.getCountryByName('James Smith');

    expect(result).toBeNull();
  });

  it('accepts case-insensitive name match', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'ron carter',
          nationalities: [{ text: 'xxu' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Ron Carter');

    expect(result).toBe('US');
  });

  it('returns null when nationalityOfEntity is absent', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({
        searchRetrieveResponse: {
          records: [
            {
              record: {
                recordData: {
                  nameType: 'Personal',
                  mainHeadings: { data: [{ text: 'Unknown Artist' }] },
                },
              },
            },
          ],
        },
      }),
    );

    const result = await client.getCountryByName('Unknown Artist');

    expect(result).toBeNull();
  });

  it('returns null when multiple nationalities disagree', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Mixed Nationality Artist',
          nationalities: [{ text: 'xxu' }, { text: 'fr' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Mixed Nationality Artist');

    expect(result).toBeNull();
  });

  it('returns ISO code when multiple sources agree on the same country', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Agreed Artist',
          nationalities: [{ text: 'fr' }, { text: 'fr.' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Agreed Artist');

    expect(result).toBe('FR');
  });

  it('strips trailing period from MARC code before lookup', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'French Artist',
          nationalities: [{ text: 'fr.' }],
        }),
      ),
    );

    const result = await client.getCountryByName('French Artist');

    expect(result).toBe('FR');
  });

  it('returns null for MARC code not in the mapping table', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Unmapped Artist',
          nationalities: [{ text: 'zzz' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Unmapped Artist');

    expect(result).toBeNull();
  });

  it('returns null when no records are returned', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeEmptyViafResponse()));
    const result = await client.getCountryByName('Nobody');
    expect(result).toBeNull();
  });

  it('retries on 429 and succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(429)).mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Jan Garbarek',
          nationalities: [{ text: 'no' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Jan Garbarek');

    expect(result).toBe('NO');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting all retries on persistent 429', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValueOnce(makeErrorResponse(429));

    const result = await client.getCountryByName('Someone');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('returns null on network error (does not throw)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network failure'));
    const result = await client.getCountryByName('Someone');
    expect(result).toBeNull();
  });

  it('returns null on non-retryable HTTP error', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500));
    const result = await client.getCountryByName('Someone');
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the configured User-Agent header', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({ preferredName: 'Ron Carter', nationalities: [{ text: 'xxu' }] }),
      ),
    );
    await client.getCountryByName('Ron Carter');
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('liner-notes/test');
  });

  it('handles a single-object (non-array) nationality entry', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Solo Entry Artist',
          nationalities: { text: 'it' },
        }),
      ),
    );

    const result = await client.getCountryByName('Solo Entry Artist');

    expect(result).toBe('IT');
  });

  it('retries on 403 (soft bot block) and succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(403)).mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Tab',
          nationalities: [{ text: 'xxu' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Tab');

    expect(result).toBe('US');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting all retries on persistent 403', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(403))
      .mockResolvedValueOnce(makeErrorResponse(403))
      .mockResolvedValueOnce(makeErrorResponse(403))
      .mockResolvedValueOnce(makeErrorResponse(403));

    const warnSpy = vi.fn();
    const clientWithLogger = new VIAFClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
    });

    const result = await clientWithLogger.getCountryByName('Tab');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Exceeded max retries'));
  });

  it('logs "bot block" in the retry warning for 403', async () => {
    const warnSpy = vi.fn();
    const clientWithLogger = new VIAFClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
    });
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(403))
      .mockResolvedValueOnce(makeOkResponse(makeEmptyViafResponse()));

    await clientWithLogger.getCountryByName('Tab');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bot block'));
  });

  it('retries on HTML response (200 OK with text/html body) and succeeds on retry', async () => {
    fetchSpy.mockResolvedValueOnce(makeHtmlResponse(200)).mockResolvedValueOnce(
      makeOkResponse(
        makeViafResponse({
          preferredName: 'Budapest String Quartet',
          nationalities: [{ text: 'hu' }],
        }),
      ),
    );

    const result = await client.getCountryByName('Budapest String Quartet');

    expect(result).toBe('HU');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null after exhausting retries on persistent HTML responses', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeHtmlResponse(200))
      .mockResolvedValueOnce(makeHtmlResponse(200))
      .mockResolvedValueOnce(makeHtmlResponse(200))
      .mockResolvedValueOnce(makeHtmlResponse(200));

    const result = await client.getCountryByName('Budapest String Quartet');

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('logs an HTML-specific warning message for HTML responses', async () => {
    const warnSpy = vi.fn();
    const clientWithLogger = new VIAFClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
    });
    fetchSpy
      .mockResolvedValueOnce(makeHtmlResponse(200))
      .mockResolvedValueOnce(makeOkResponse(makeEmptyViafResponse()));

    await clientWithLogger.getCountryByName('Vulfmon');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTML response'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Network error'));
  });
});

describe('buildViafClientFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when MUSICBRAINZ_USER_AGENT is not set', () => {
    delete process.env['MUSICBRAINZ_USER_AGENT'];
    expect(buildViafClientFromEnv()).toBeNull();
  });

  it('returns a VIAFClient when MUSICBRAINZ_USER_AGENT is set', () => {
    process.env['MUSICBRAINZ_USER_AGENT'] = 'liner-notes/test';
    expect(buildViafClientFromEnv()).toBeInstanceOf(VIAFClient);
  });
});
