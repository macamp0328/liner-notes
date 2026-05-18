import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  AcousticBrainzClient,
  MAX_RECORDING_IDS_PER_CALL,
  buildAcousticBrainzClientFromEnv,
} from '../../../src/ingestion/acousticbrainz-client.js';

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

const MBID_A = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const MBID_B = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

function makeLowLevel(bpm = 130.5) {
  return {
    rhythm: { bpm },
    tonal: { key_key: 'C', key_scale: 'minor' },
    lowlevel: { average_loudness: 0.8, dynamic_complexity: 5.2 },
  };
}

function makeHighLevel(danceable = 0.75, voice = 'voice') {
  return {
    highlevel: {
      danceability: { all: { danceable } },
      voice_instrumental: { value: voice },
    },
  };
}

/** Build a valid bulk low-level response keyed by MBID. */
function bulkLow(mbid: string, data: object = makeLowLevel()) {
  return { [mbid]: { '0': data } };
}

/** Build a valid bulk high-level response keyed by MBID. */
function bulkHigh(mbid: string, data: object = makeHighLevel()) {
  return { [mbid]: { '0': data } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcousticBrainzClient', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: AcousticBrainzClient;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    client = new AcousticBrainzClient({
      userAgent: 'liner-notes/test',
      delayMs: 0,
      backoffBaseMs: 0,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // ── getFeatures ────────────────────────────────────────────────────────────

  it('returns empty map without fetching when mbids is empty', async () => {
    const result = await client.getFeatures([]);
    expect(result.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when more than MAX_RECORDING_IDS_PER_CALL mbids are provided', async () => {
    const mbids = Array.from(
      { length: MAX_RECORDING_IDS_PER_CALL + 1 },
      (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
    );
    await expect(client.getFeatures(mbids)).rejects.toThrow(/at most 25/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('extracts all low-level and high-level features for a single MBID', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(bulkLow(MBID_A)))
      .mockResolvedValueOnce(makeOkResponse(bulkHigh(MBID_A)));

    const result = await client.getFeatures([MBID_A]);

    expect(result.get(MBID_A)).toEqual({
      tempo: 130.5,
      musicalKey: 'C',
      musicalScale: 'minor',
      loudnessDb: 0.8,
      dynamicComplexity: 5.2,
      danceabilityEstimate: 0.75,
      voiceInstrumental: 'voice',
    });
    expect(result.size).toBe(1);

    const lowLevelUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(lowLevelUrl).toContain('/low-level');
    expect(lowLevelUrl).toContain(MBID_A);
    const highLevelUrl = fetchSpy.mock.calls[1]?.[0] as string;
    expect(highLevelUrl).toContain('/high-level');
    expect(highLevelUrl).toContain(MBID_A);
  });

  it('passes multiple mbids joined with semicolons', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({})).mockResolvedValueOnce(makeOkResponse({}));

    await client.getFeatures([MBID_A, MBID_B]);

    const lowUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(lowUrl).toContain(`${MBID_A};${MBID_B}`);
  });

  it('omits a MBID from the result map when absent from both responses', async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({})).mockResolvedValueOnce(makeOkResponse({}));

    const result = await client.getFeatures([MBID_A]);
    expect(result.has(MBID_A)).toBe(false);
    expect(result.size).toBe(0);
  });

  it('includes a MBID when only the low-level response has data', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(bulkLow(MBID_A)))
      .mockResolvedValueOnce(makeOkResponse({}));

    const result = await client.getFeatures([MBID_A]);
    const features = result.get(MBID_A);
    expect(features).toBeDefined();
    expect(features?.tempo).toBe(130.5);
    expect(features?.danceabilityEstimate).toBeNull();
  });

  it('returns null for missing or non-finite numeric fields', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse({ [MBID_A]: { '0': { rhythm: {}, tonal: {}, lowlevel: {} } } }),
      )
      .mockResolvedValueOnce(makeOkResponse({}));

    const result = await client.getFeatures([MBID_A]);
    const features = result.get(MBID_A);
    expect(features?.tempo).toBeNull();
    expect(features?.musicalKey).toBeNull();
  });

  it('returns null for empty-string fields', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeOkResponse({
          [MBID_A]: {
            '0': { rhythm: { bpm: 100 }, tonal: { key_key: '', key_scale: 'major' }, lowlevel: {} },
          },
        }),
      )
      .mockResolvedValueOnce(makeOkResponse({}));

    const result = await client.getFeatures([MBID_A]);
    expect(result.get(MBID_A)?.musicalKey).toBeNull();
    expect(result.get(MBID_A)?.musicalScale).toBe('major');
  });

  // ── 429 backoff ────────────────────────────────────────────────────────────

  it('retries on 429 and succeeds after backoff', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests'))
      .mockResolvedValueOnce(makeOkResponse(bulkLow(MBID_A)))
      .mockResolvedValueOnce(makeOkResponse(bulkHigh(MBID_A)));

    const result = await client.getFeatures([MBID_A]);
    expect(result.has(MBID_A)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After header (seconds) on 429', async () => {
    // backoffBaseMs: 0 means we rely only on Retry-After
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429, 'Too Many Requests', 2))
      .mockResolvedValueOnce(makeOkResponse(bulkLow(MBID_A)))
      .mockResolvedValueOnce(makeOkResponse(bulkHigh(MBID_A)));

    const promise = client.getFeatures([MBID_A]);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.has(MBID_A)).toBe(true);
    vi.useRealTimers();
  });

  it('throws on non-ok status other than 429/503', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));
    await expect(client.getFeatures([MBID_A])).rejects.toThrow(/500/);
  });

  it('throws after exhausting max retries on repeated 429', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(429, 'Too Many Requests'));
    await expect(client.getFeatures([MBID_A])).rejects.toThrow(/exceeded max retries/);
  });

  // ── buildAcousticBrainzClientFromEnv ──────────────────────────────────────

  it('uses ACOUSTICBRAINZ_USER_AGENT when set', () => {
    vi.stubEnv('ACOUSTICBRAINZ_USER_AGENT', 'my-app/2.0 (me@example.com)');
    fetchSpy.mockResolvedValue(makeOkResponse({}));
    const c = buildAcousticBrainzClientFromEnv();
    // getFeatures is the only public method — just confirm client builds without error
    expect(c).toBeInstanceOf(AcousticBrainzClient);
  });

  it('defaults user agent when ACOUSTICBRAINZ_USER_AGENT is unset', () => {
    vi.stubEnv('ACOUSTICBRAINZ_USER_AGENT', undefined);
    const c = buildAcousticBrainzClientFromEnv();
    expect(c).toBeInstanceOf(AcousticBrainzClient);
  });
});
