import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { Driver } from 'neo4j-driver';
import {
  enrichLyrics,
  resolveReloadLyricsConcurrency,
  resolveLyricsRetryRounds,
  isRetryableLyricsError,
  type LyricsClients,
} from '../../../src/enrichment/lyrics.js';
import { LrclibClient } from '../../../src/ingestion/lrclib-client.js';
import { GeniusClient } from '../../../src/ingestion/genius-client.js';
import { RetriesExhaustedError } from '../../../src/ingestion/rate-limited-fetch.js';
import { closedSnapshot } from '../../../src/ingestion/circuit-breaker.js';
import { snapshotEnv } from '../../helpers/env.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — factories run before module-level vi.mock() calls resolve.
// ---------------------------------------------------------------------------
const mockGetUnenrichedTracks = vi.hoisted(() => vi.fn());
const mockSetTrackLyrics = vi.hoisted(() => vi.fn());
const mockMarkLyricsFetched = vi.hoisted(() => vi.fn());
const mockMarkTrackInstrumental = vi.hoisted(() => vi.fn());
const mockMarkTrackProbableInstrumental = vi.hoisted(() => vi.fn());
const mockMarkTrackLowConfidence = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/lyrics-repository.js', () => ({
  getUnenrichedTracks: mockGetUnenrichedTracks,
  setTrackLyrics: mockSetTrackLyrics,
  markLyricsFetched: mockMarkLyricsFetched,
  markTrackInstrumental: mockMarkTrackInstrumental,
  markTrackProbableInstrumental: mockMarkTrackProbableInstrumental,
  markTrackLowConfidence: mockMarkTrackLowConfidence,
}));

// ---------------------------------------------------------------------------
// Fixtures (imported after vi.mock calls)
// ---------------------------------------------------------------------------
import lrclibHit from '../../fixtures/lrclib-hit.json' with { type: 'json' };
import geniusSearchHit from '../../fixtures/genius-search-hit.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeOkResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 400,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : ''),
  } as unknown as Response;
}

function makeHtmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(html),
  } as unknown as Response;
}

// A retryable (5xx) response needs `headers.get` because the shared rate-limited-fetch core
// reads `Retry-After` on every retried status. The plain makeOkResponse omits it.
function makeRetryableResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// Zero-backoff clients so the global-fetch-spy assertions run instantly (no real retry waits).
function makeLrclib(): LrclibClient {
  return new LrclibClient({ userAgent: 'liner-notes/test', delayMs: 0, backoffBaseMs: 0 });
}
function makeGenius(userAgent = 'Mozilla/5.0 (test-browser)'): GeniusClient {
  return new GeniusClient({ token: 'test-genius-token', userAgent, delayMs: 0, backoffBaseMs: 0 });
}
/** Inject LRCLIB always; Genius only when `withGenius` (else `null` = unconfigured/prod path). */
function clients(withGenius: boolean, geniusUa?: string): LyricsClients {
  return { lrclib: makeLrclib(), genius: withGenius ? makeGenius(geniusUa) : null };
}

const sampleTrack = {
  title: 'Song Title',
  position: 'A1',
  releaseDiscogsId: 13570466,
  artistName: 'Test Artist',
  voiceInstrumental: null as string | null,
  // Matches lrclibHit.duration (180) so the LRCLIB resolved path exercises a confirmed duration.
  durationSeconds: 180 as number | null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('resolveReloadLyricsConcurrency (#372)', () => {
  const env = snapshotEnv(['LYRICS_CONCURRENCY', 'RELOAD_LYRICS_CONCURRENCY']);

  beforeEach(() => env.clear());
  afterEach(() => env.restore());

  it('uses RELOAD_LYRICS_CONCURRENCY when set', () => {
    process.env['RELOAD_LYRICS_CONCURRENCY'] = '3';
    process.env['LYRICS_CONCURRENCY'] = '8';
    expect(resolveReloadLyricsConcurrency()).toBe(3);
  });

  it('falls back to LYRICS_CONCURRENCY when the reload override is unset', () => {
    process.env['LYRICS_CONCURRENCY'] = '4';
    expect(resolveReloadLyricsConcurrency()).toBe(4);
  });

  it('falls back to the default of 6 when both are unset', () => {
    expect(resolveReloadLyricsConcurrency()).toBe(6);
  });

  it('clamps the reload override to [1, 12]', () => {
    process.env['RELOAD_LYRICS_CONCURRENCY'] = '0';
    expect(resolveReloadLyricsConcurrency()).toBe(1);
    process.env['RELOAD_LYRICS_CONCURRENCY'] = '99';
    expect(resolveReloadLyricsConcurrency()).toBe(12);
  });

  it('falls through to LYRICS_CONCURRENCY on a non-numeric reload override', () => {
    process.env['RELOAD_LYRICS_CONCURRENCY'] = 'abc';
    process.env['LYRICS_CONCURRENCY'] = '2';
    expect(resolveReloadLyricsConcurrency()).toBe(2);
  });
});

describe('resolveLyricsRetryRounds (#455)', () => {
  const env = snapshotEnv(['LYRICS_RETRY_ROUNDS']);

  beforeEach(() => env.clear());
  afterEach(() => env.restore());

  it('defaults to 2 when unset', () => {
    expect(resolveLyricsRetryRounds()).toBe(2);
  });

  it('honours an explicit value', () => {
    process.env['LYRICS_RETRY_ROUNDS'] = '5';
    expect(resolveLyricsRetryRounds()).toBe(5);
  });

  it('treats 0 as disabled', () => {
    process.env['LYRICS_RETRY_ROUNDS'] = '0';
    expect(resolveLyricsRetryRounds()).toBe(0);
  });

  it('clamps a negative value to 0 (disabled), not an unbounded loop', () => {
    process.env['LYRICS_RETRY_ROUNDS'] = '-3';
    expect(resolveLyricsRetryRounds()).toBe(0);
  });

  it('falls back to the default on a non-numeric value', () => {
    process.env['LYRICS_RETRY_ROUNDS'] = 'abc';
    expect(resolveLyricsRetryRounds()).toBe(2);
  });
});

describe('isRetryableLyricsError (#455)', () => {
  it('treats a request timeout as retryable', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(isRetryableLyricsError(timeout)).toBe(true);
  });

  it('treats an undici "fetch failed" network error as retryable', () => {
    expect(isRetryableLyricsError(new Error('fetch failed'))).toBe(true);
  });

  it('treats a 429/5xx retry-budget exhaustion as retryable', () => {
    expect(isRetryableLyricsError(new RetriesExhaustedError('LRCLIB API', 3, 'http://x'))).toBe(
      true,
    );
  });

  it('does not retry a plain non-ok error (fatal-ish status)', () => {
    expect(isRetryableLyricsError(new Error('LRCLIB API error 451 for http://x'))).toBe(false);
  });

  it('does not retry a contract error', () => {
    expect(
      isRetryableLyricsError(new Error('resolve() returned null but the stage declares no ...')),
    ).toBe(false);
  });
});

describe('enrichLyrics', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const savedConcurrency = process.env['LYRICS_CONCURRENCY'];
  const savedRetryRounds = process.env['LYRICS_RETRY_ROUNDS'];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['GENIUS_TOKEN'];
    delete process.env['GENIUS_USER_AGENT'];
    // Force serial so call-order assertions are deterministic; the worker pool is covered in
    // run.test.ts. (Intra-stage concurrency is an orthogonal concern from lyrics' own logic.)
    process.env['LYRICS_CONCURRENCY'] = '1';
    // Disable the in-run retry sweep (#455) by default so these transient-failure tests assert the
    // single-attempt behaviour without a real backoff; the sweep has its own describe below, which
    // opts in via the `opts.retry` seam with an injected no-op sleep.
    process.env['LYRICS_RETRY_ROUNDS'] = '0';

    mockGetUnenrichedTracks.mockResolvedValue([]);
    mockSetTrackLyrics.mockResolvedValue(undefined);
    mockMarkLyricsFetched.mockResolvedValue(undefined);
    mockMarkTrackInstrumental.mockResolvedValue(undefined);
    mockMarkTrackProbableInstrumental.mockResolvedValue(undefined);

    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (savedConcurrency === undefined) delete process.env['LYRICS_CONCURRENCY'];
    else process.env['LYRICS_CONCURRENCY'] = savedConcurrency;
    if (savedRetryRounds === undefined) delete process.env['LYRICS_RETRY_ROUNDS'];
    else process.env['LYRICS_RETRY_ROUNDS'] = savedRetryRounds;
    delete process.env['CIRCUIT_BREAKER_THRESHOLD'];
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Empty tracks
  // -------------------------------------------------------------------------
  it('returns zero counts when no tracks need enrichment', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([]);

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // LRCLIB success
  // -------------------------------------------------------------------------
  it('enriches a track from LRCLIB and stores plainLyrics with source lrclib', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse(lrclibHit));
    const onProgress = vi.fn();

    const summary = await enrichLyrics(fakeDriver, undefined, onProgress, clients(false));

    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(mockSetTrackLyrics).toHaveBeenCalledOnce();
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      lrclibHit.plainLyrics,
      'lrclib',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
    // Progress is reported against the track work-list (1 track here).
    expect(onProgress).toHaveBeenCalledWith(0, 1);
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
  });

  it('sends an identifying User-Agent on the LRCLIB request', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse(lrclibHit));

    await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('liner-notes/test');
  });

  // An over-max opts.concurrency override (the reload's seam, #372) is clamped to [1, 12] like the
  // env resolvers — it must not bypass the MAX_CONCURRENCY ceiling — and still enriches correctly.
  it('honours and clamps an opts.concurrency override', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse(lrclibHit));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false), {
      concurrency: 999,
    });

    expect(summary.enriched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(mockSetTrackLyrics).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Match-confidence gate (#248)
  // -------------------------------------------------------------------------
  it('downgrades an LRCLIB hit with a divergent duration to low-confidence (lyrics not stored)', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]); // durationSeconds 180
    // Same title/artist but a wildly different duration — a live/remix, not this recording.
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ ...lrclibHit, duration: 600 }));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(summary.enriched).toBe(1); // low-confidence still flows through write
    expect(mockSetTrackLyrics).not.toHaveBeenCalled(); // lyric text is NOT stored
    expect(mockMarkTrackLowConfidence).toHaveBeenCalledOnce();
    expect(mockMarkTrackLowConfidence).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'lrclib',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
  });

  it('routes a below-gate Genius hit to low-confidence, storing provenance not lyrics', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    // The real GeniusClient's pre-fetch filter mirrors the gate, so a wrong-title hit never escapes
    // it; inject a stub returning one to prove the orchestrator gate + low-confidence routing.
    const fakeGenius = {
      getLyrics: vi.fn().mockResolvedValue({
        lyrics: 'Some words',
        matchedTitle: 'A Completely Different Song',
        matchedArtist: 'Test Artist',
      }),
      breakerSnapshot: () => closedSnapshot('genius'),
    } as unknown as GeniusClient;
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404)); // LRCLIB 404 → Genius fallback

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, {
      lrclib: makeLrclib(),
      genius: fakeGenius,
    });

    expect(summary.enriched).toBe(1);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    expect(mockMarkTrackLowConfidence).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'genius',
      expect.any(Number),
      'A Completely Different Song',
      'Test Artist',
    );
  });

  // -------------------------------------------------------------------------
  // LRCLIB instrumental flag — terminal, short-circuits Genius (#246)
  // -------------------------------------------------------------------------
  it('classifies an LRCLIB instrumental terminally and never calls Genius (even with a token)', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    // LRCLIB 200 with instrumental:true and no plainLyrics — its normal instrumental shape.
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ instrumental: true }));

    // Genius client injected and configured, to prove it is never reached on an instrumental.
    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(mockMarkTrackInstrumental).toHaveBeenCalledOnce();
    expect(mockMarkTrackInstrumental).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
    );
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    expect(mockMarkTrackProbableInstrumental).not.toHaveBeenCalled();
    // Only the single LRCLIB fetch — no Genius search/scrape on an instrumental.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // probable-instrumental — AcousticBrainz signal short-circuits Genius (#246)
  // -------------------------------------------------------------------------
  it('classifies probable-instrumental from voiceInstrumental when LRCLIB has no record, skipping Genius', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([
      { ...sampleTrack, voiceInstrumental: 'instrumental' },
    ]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404)); // LRCLIB 404 — no record

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(mockMarkTrackProbableInstrumental).toHaveBeenCalledOnce();
    expect(mockMarkTrackProbableInstrumental).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
    );
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    expect(mockMarkTrackInstrumental).not.toHaveBeenCalled();
    // voiceInstrumental check precedes Genius — only the LRCLIB fetch happened.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // voiceInstrumental='voice' does NOT short-circuit — Genius still runs (#246)
  // -------------------------------------------------------------------------
  it('falls through to Genius when voiceInstrumental is "voice" and LRCLIB has no record', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([{ ...sampleTrack, voiceInstrumental: 'voice' }]);
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse('<div data-lyrics-container="true">Hi</div>'));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(mockMarkTrackProbableInstrumental).not.toHaveBeenCalled();
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'Hi',
      'genius',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // LRCLIB 404 — no Genius client
  // -------------------------------------------------------------------------
  it('skips track when LRCLIB returns 404 and Genius is not configured', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // Both sources empty — stamp the attempt so it's throttled, not retried every run.
    expect(mockMarkLyricsFetched).toHaveBeenCalledOnce();
    // Only one fetch call — no Genius fallback
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // LRCLIB network error
  // -------------------------------------------------------------------------
  it('increments failed when LRCLIB throws a network error', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockRejectedValueOnce(new Error('Network failure'));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // LRCLIB 5xx — now retried, then exhausted to a thrown error (still counted failed)
  // -------------------------------------------------------------------------
  it('retries an LRCLIB 5xx and counts failed after the budget is spent', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValue(makeRetryableResponse(500)); // every attempt 500s

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(summary.failed).toBe(1);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // Transient error must NOT stamp the attempt — the track retries next run.
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();
    // 3 retries + the initial attempt — the hardened client recovered nothing, then gave up.
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // In-run retry sweep (#455) — a transient LRCLIB blip recovers within the run
  // -------------------------------------------------------------------------
  it('recovers a transient LRCLIB timeout within the run via the retry sweep', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    // First attempt times out (fail-fast, counted failed); the sweep's re-attempt succeeds.
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    fetchSpy.mockRejectedValueOnce(timeout).mockResolvedValue(makeOkResponse(lrclibHit));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false), {
      // Inject a no-op sleep so the sweep's backoff is instant — no fake timers, mirroring the
      // zero-backoff clients. maxRounds overrides the beforeEach LYRICS_RETRY_ROUNDS=0.
      retry: { maxRounds: 1, sleep: async (): Promise<void> => {} },
    });

    expect(summary.enriched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.recovered).toBe(1);
    expect(mockSetTrackLyrics).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Genius fallback — success
  // -------------------------------------------------------------------------
  it('falls back to Genius and enriches when LRCLIB returns 404 and Genius is configured', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const geniusLyricsHtml = '<div data-lyrics-container="true">Hello<br/>World</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(geniusLyricsHtml)); // Genius HTML page

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(mockSetTrackLyrics).toHaveBeenCalledOnce();
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'Hello\nWorld',
      'genius',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();

    // Both Genius requests carry the browser-like User-Agent to clear Cloudflare's bot check (#195).
    const searchHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(searchHeaders['Authorization']).toBe('Bearer test-genius-token');
    expect(searchHeaders['User-Agent']).toContain('Mozilla/5.0');
    expect(searchHeaders['Accept']).toBe('application/json');

    const pageHeaders = (fetchSpy.mock.calls[2]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(pageHeaders['User-Agent']).toContain('Mozilla/5.0');
    expect(pageHeaders['Accept']).toContain('text/html');
  });

  // -------------------------------------------------------------------------
  // Default wiring — Genius client built from env carries the browser UA (#195/#236)
  // -------------------------------------------------------------------------
  it('builds clients from env (default browser UA) when none are injected', async () => {
    process.env['GENIUS_TOKEN'] = 'env-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404 (built from env)
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse('<div data-lyrics-container="true">Hi</div>'));

    const summary = await enrichLyrics(fakeDriver); // no injected clients

    expect(summary.enriched).toBe(1);
    const searchHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(searchHeaders['Authorization']).toBe('Bearer env-token');
    expect(searchHeaders['User-Agent']).toContain('Mozilla/5.0');
  });

  // -------------------------------------------------------------------------
  // Genius fallback — no search hits
  // -------------------------------------------------------------------------
  it('skips track when Genius search returns no hits', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const emptySearch = { meta: { status: 200 }, response: { hits: [] } };
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(emptySearch)); // Genius search no hits

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    expect(mockMarkLyricsFetched).toHaveBeenCalledOnce();
    expect(mockMarkLyricsFetched).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
    );
    // No third fetch — no page to scrape when there are no hits
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Genius skipped when client is null
  // -------------------------------------------------------------------------
  it('does not call Genius when the Genius client is null', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404)); // only LRCLIB called

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBe(1);
    expect(mockMarkLyricsFetched).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Genius network error
  // -------------------------------------------------------------------------
  it('increments failed when Genius search throws a network error', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockRejectedValueOnce(new Error('Genius network error'));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius page 403 — expected Cloudflare bot-block logs at warn, not error (#243)
  // -------------------------------------------------------------------------
  it('logs an expected Genius page 403 at warn, not error', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    const logger = makeMockLogger();
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeOkResponse({}, 403)); // Genius page bot-block

    const summary = await enrichLyrics(fakeDriver, logger, undefined, clients(true));

    expect(summary.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Genius page returned 403'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius search 403 — same bot-block path, warn not error (#243)
  // -------------------------------------------------------------------------
  it('logs an expected Genius search 403 at warn, not error', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    const logger = makeMockLogger();
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse({}, 403)); // Genius search bot-block

    const summary = await enrichLyrics(fakeDriver, logger, undefined, clients(true));

    expect(summary.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Genius search returned 403'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius 5xx — retried, then exhausted to an unexpected error → surfaces at error (#243)
  // -------------------------------------------------------------------------
  it('logs an unexpected Genius 5xx at error after exhausting retries', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    const logger = makeMockLogger();
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValue(makeRetryableResponse(500)); // Genius page 500s every attempt

    const summary = await enrichLyrics(fakeDriver, logger, undefined, clients(true));

    expect(summary.failed).toBe(1);
    // An exhausted retryable status is a RetriesExhaustedError, not a GeniusHttpError → error level.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Genius API'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('max retries'));
  });

  // -------------------------------------------------------------------------
  // Genius HTML with no lyrics containers
  // -------------------------------------------------------------------------
  it('skips track when Genius page contains no data-lyrics-container divs', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse('<html><body>No lyrics here</body></html>'));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Mixed results — summary counts (serial via LYRICS_CONCURRENCY=1)
  // -------------------------------------------------------------------------
  it('counts enriched, skipped, and failed correctly across multiple tracks', async () => {
    const track1 = { ...sampleTrack, position: 'A1', title: 'Track 1' };
    const track2 = { ...sampleTrack, position: 'A2', title: 'Track 2' };
    const track3 = { ...sampleTrack, position: 'A3', title: 'Track 3' };
    mockGetUnenrichedTracks.mockResolvedValue([track1, track2, track3]);

    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)) // track1: LRCLIB hit
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // track2: LRCLIB 404, no genius → skip
      .mockRejectedValueOnce(new Error('Network failure')); // track3: LRCLIB throws

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Null artist name — passes empty string to LRCLIB
  // -------------------------------------------------------------------------
  it('calls LRCLIB with empty string for artistName when track has no artist', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([{ ...sampleTrack, artistName: null }]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse(lrclibHit));

    await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    const [lrclibUrl] = fetchSpy.mock.calls[0] as [string];
    expect(lrclibUrl).toContain('artist_name=');
    expect(mockSetTrackLyrics).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Genius — type !== 'song' guard
  // -------------------------------------------------------------------------
  it('skips track when Genius search hit type is not song', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const articleHit = {
      meta: { status: 200 },
      response: {
        hits: [
          {
            type: 'article',
            result: {
              id: 12345,
              url: 'https://genius.com/some-article',
              primary_artist: { name: 'Test Artist' },
            },
          },
        ],
      },
    };
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(articleHit)); // Genius search returns article

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // No page fetch — type guard fired before fetching the page
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Genius — artist mismatch guard
  // -------------------------------------------------------------------------
  it('skips track when Genius primary artist does not match query artist', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const wrongArtistHit = {
      meta: { status: 200 },
      response: {
        hits: [
          {
            type: 'song',
            result: {
              id: 99999,
              url: 'https://genius.com/completely-different-artist-song-lyrics',
              primary_artist: { name: 'Completely Different Artist' },
            },
          },
        ],
      },
    };
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(wrongArtistHit)); // Genius search with wrong artist

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // No page fetch — artist guard fired before fetching the page
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Genius — contributor header is stripped before validating (#253)
  // -------------------------------------------------------------------------
  it('strips the contributor header and enriches with the body that follows', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const headerHtml = `
      <div data-lyrics-container="true">
        <div class="header">8 ContributorsMusic For Indigo Lyrics</div>
        Actual lyrics would follow here
      </div>
    `;
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(headerHtml)); // Genius page with header

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'Actual lyrics would follow here',
      'genius',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
  });

  it('skips track when the Genius page is a header-only (instrumental) container', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const headerOnlyHtml =
      '<div data-lyrics-container="true">2 ContributorsSong Title Lyrics</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(headerOnlyHtml));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius — oversized content guard (book / article scraped)
  // -------------------------------------------------------------------------
  it('skips track when Genius page returns content exceeding 15,000 characters', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const oversizedContent = 'A'.repeat(15_001);
    const oversizedHtml = `<div data-lyrics-container="true">${oversizedContent}</div>`;
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(oversizedHtml));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius — HTML entity decoding
  // -------------------------------------------------------------------------
  it('stores lyrics with HTML entities decoded', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const entityHtml = '<div data-lyrics-container="true">I&#x27;ll never leave you &amp; me</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(entityHtml));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      "I'll never leave you & me",
      'genius',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
  });

  // -------------------------------------------------------------------------
  // Genius — multiple lyrics containers joined
  // -------------------------------------------------------------------------
  it('joins multiple data-lyrics-container divs with double newline', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const multiHtml = `
      <div data-lyrics-container="true">Verse 1</div>
      <div data-lyrics-container="true">Chorus</div>
    `;
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(multiHtml));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'Verse 1\n\nChorus',
      'genius',
      expect.any(Number),
      'Song Title',
      'Test Artist',
    );
  });

  // -------------------------------------------------------------------------
  // Genius — no double-unescaping (CodeQL js/double-escaping)
  // -------------------------------------------------------------------------
  it('does not double-unescape entities that decode to ampersands', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html = '<div data-lyrics-container="true">&#38;lt;b&#38;gt; stays text</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    const stored = mockSetTrackLyrics.mock.calls[0]?.[3] as string;
    expect(stored).toBe('&lt;b&gt; stays text');
    expect(stored).not.toContain('<b>');
  });

  // -------------------------------------------------------------------------
  // Genius — strips script content (CodeQL js/incomplete-multi-character-sanitization)
  // -------------------------------------------------------------------------
  it('drops <script> blocks and their content from extracted lyrics', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html = '<div data-lyrics-container="true">Hello<script>alert(\'x\')</script> World</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    const stored = mockSetTrackLyrics.mock.calls[0]?.[3] as string;
    expect(stored).toBe('Hello World');
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('alert');
  });

  // -------------------------------------------------------------------------
  // Genius — neutralises unterminated tag fragments (no <script left behind)
  // -------------------------------------------------------------------------
  it('strips a stray "<script" fragment with no closing bracket', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html = '<div data-lyrics-container="true">lyrics here <script and more</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    const stored = mockSetTrackLyrics.mock.calls[0]?.[3] as string;
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('<');
    expect(stored).toContain('lyrics here');
  });

  // -------------------------------------------------------------------------
  // Genius — entity-encoded script block cannot be reconstructed after decode
  // -------------------------------------------------------------------------
  it('drops an entity-encoded <script> block (no markup after decoding)', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html =
      '<div data-lyrics-container="true">Safe&lt;script&gt;alert(1)&lt;/script&gt; lyrics</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    const stored = mockSetTrackLyrics.mock.calls[0]?.[3] as string;
    expect(stored).toBe('Safe lyrics');
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('alert');
  });

  // -------------------------------------------------------------------------
  // Genius — nested <script> blocks fully removed (fixpoint block removal)
  // -------------------------------------------------------------------------
  it('drops nested <script> blocks without leaving markup', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html =
      '<div data-lyrics-container="true">Safe<script><script>alert(1)</script></script> lyrics</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(1);
    const stored = mockSetTrackLyrics.mock.calls[0]?.[3] as string;
    expect(stored).toBe('Safe lyrics');
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('alert');
  });

  // -------------------------------------------------------------------------
  // Initial query failure — returns a failed summary instead of throwing (#151)
  // -------------------------------------------------------------------------
  it('returns a failed summary (does not throw) when the initial track query fails', async () => {
    mockGetUnenrichedTracks.mockRejectedValue(new Error('Neo4j unavailable'));

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // LRCLIB write failure — counts failed and continues to the next track (#151)
  // -------------------------------------------------------------------------
  it('counts failed and continues when the LRCLIB lyrics write throws', async () => {
    // Titles match the fixture's trackName so both clear the confidence gate and reach the write.
    const track1 = { ...sampleTrack, position: 'A1' };
    const track2 = { ...sampleTrack, position: 'A2' };
    mockGetUnenrichedTracks.mockResolvedValue([track1, track2]);

    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)) // track1: LRCLIB hit → write throws
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)); // track2: LRCLIB hit → write succeeds
    mockSetTrackLyrics
      .mockRejectedValueOnce(new Error('Neo4j write failed')) // track1 write
      .mockResolvedValueOnce(undefined); // track2 write

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(false));

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    // Both tracks attempted a write — the first throw did not abort the loop
    expect(mockSetTrackLyrics).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Double-count guard (#222) — an LRCLIB throw short-circuits the Genius fallback,
  // so one track can only ever increment `failed` once.
  // -------------------------------------------------------------------------
  it('counts failed exactly once and never reaches Genius when LRCLIB throws', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockRejectedValueOnce(new Error('LRCLIB down')); // LRCLIB throws

    const summary = await enrichLyrics(fakeDriver, undefined, undefined, clients(true));

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    // Genius is never attempted — only the single LRCLIB fetch happened.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Transient failure must not stamp — the track retries next run.
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Circuit breaker surfacing (#242) — the in-prod Genius 403 fix (#240)
  // -------------------------------------------------------------------------
  it('opens the Genius breaker after N 403s, skips Genius for later tracks, and surfaces it', async () => {
    process.env['CIRCUIT_BREAKER_THRESHOLD'] = '2';
    const injected = clients(true); // builds the Genius/LRCLIB breakers at threshold 2
    mockGetUnenrichedTracks.mockResolvedValue(
      [0, 1, 2].map((i) => ({ ...sampleTrack, position: `A${i}` })),
    );
    fetchSpy
      .mockResolvedValueOnce(makeRetryableResponse(404)) // t0 LRCLIB miss
      .mockResolvedValueOnce(makeRetryableResponse(403)) // t0 Genius search 403 (fatal 1)
      .mockResolvedValueOnce(makeRetryableResponse(404)) // t1 LRCLIB miss
      .mockResolvedValueOnce(makeRetryableResponse(403)) // t1 Genius search 403 (fatal 2 → opens)
      .mockResolvedValueOnce(makeRetryableResponse(404)); // t2 LRCLIB miss (Genius short-circuited)
    const log = makeMockLogger();

    const summary = await enrichLyrics(fakeDriver, log, undefined, injected);

    // 5 fetches: 2 for each of the first two tracks, 1 for the third (Genius skipped).
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(summary.geniusBreakerOpen).toBe(1);
    expect(summary.geniusFatalCount).toBe(2);
    expect(summary.lrclibBreakerOpen).toBe(0);
    // First two throw (failed, unstamped); the third skips Genius and IS stamped.
    expect(summary.failed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(mockMarkLyricsFetched).toHaveBeenCalledTimes(1);
  });
});
