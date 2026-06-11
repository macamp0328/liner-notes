import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import { enrichLyrics } from '../../../src/enrichment/lyrics.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedTracks = vi.hoisted(() => vi.fn());
const mockSetTrackLyrics = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/lyrics-repository.js', () => ({
  getUnenrichedTracks: mockGetUnenrichedTracks,
  setTrackLyrics: mockSetTrackLyrics,
}));

// ---------------------------------------------------------------------------
// Fixtures
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

function makeMockSession(runResult: unknown = { records: [] }): {
  session: Session;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = vi.fn().mockResolvedValue(runResult);
  const session = {
    run: runSpy,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

const tracks = [
  { title: 'Track One', position: 'A1', releaseDiscogsId: 100, artistName: 'Artist A' },
  { title: 'Track Two', position: 'A2', releaseDiscogsId: 100, artistName: 'Artist A' },
  { title: 'Track Three', position: 'B1', releaseDiscogsId: 101, artistName: 'Artist B' },
];

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------
describe('enrichLyrics integration', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  const savedConcurrency = process.env['LYRICS_CONCURRENCY'];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['GENIUS_TOKEN'];
    // Pin serial so the call-order mock chains below are deterministic; the worker pool is
    // covered in tests/unit/enrichment/run.test.ts.
    process.env['LYRICS_CONCURRENCY'] = '1';

    mockGetUnenrichedTracks.mockResolvedValue([]);
    mockSetTrackLyrics.mockResolvedValue(undefined);

    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (savedConcurrency === undefined) delete process.env['LYRICS_CONCURRENCY'];
    else process.env['LYRICS_CONCURRENCY'] = savedConcurrency;
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Full LRCLIB pass — all tracks found
  // -------------------------------------------------------------------------
  it('enriches all tracks from LRCLIB when all are found', async () => {
    mockGetUnenrichedTracks.mockResolvedValue(tracks);
    fetchSpy.mockResolvedValue(makeOkResponse(lrclibHit));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(mockSetTrackLyrics).toHaveBeenCalledTimes(3);

    const calls = mockSetTrackLyrics.mock.calls as unknown[][];
    const sources = calls.map((c) => c[4]);
    expect(sources.every((s) => s === 'lrclib')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Mixed results
  // -------------------------------------------------------------------------
  it('handles mixed LRCLIB / Genius / skip / fail results correctly', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue(tracks);

    // Artist name must match track[1].artistName ('Artist A') to pass the fuzzy match guard.
    const artistAHit = {
      meta: { status: 200 },
      response: {
        hits: [
          {
            type: 'song',
            result: {
              id: 12345,
              url: 'https://genius.com/Artist-a-track-two-lyrics',
              primary_artist: { id: 999, name: 'Artist A' },
            },
          },
        ],
      },
    };
    const geniusHtml = '<div data-lyrics-container="true">Genius lyrics</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)) // track[0]: LRCLIB hit
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // track[1]: LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(artistAHit)) //   Genius search — artist matches
      .mockResolvedValueOnce(makeHtmlResponse(geniusHtml)) //   Genius page
      .mockRejectedValueOnce(new Error('LRCLIB timeout')); // track[2]: LRCLIB throws

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(2); // track[0] lrclib + track[1] genius
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1); // track[2]
    expect(mockSetTrackLyrics).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Idempotency — tracks with lyrics are absent from getUnenrichedTracks
  // -------------------------------------------------------------------------
  it('does not re-enrich tracks that already have lyrics', async () => {
    // First run: 3 tracks without lyrics
    mockGetUnenrichedTracks.mockResolvedValueOnce(tracks);
    fetchSpy.mockResolvedValue(makeOkResponse(lrclibHit));
    await enrichLyrics(fakeDriver);

    // Second run: getUnenrichedTracks returns empty (WHERE t.lyrics IS NULL filters them out)
    mockGetUnenrichedTracks.mockResolvedValueOnce([]);
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Full-text index: schema defines trackLyrics index for post-enrichment queries
  // -------------------------------------------------------------------------
  it('schema defines the trackLyrics full-text index on Track nodes', async () => {
    // applySchema is not mocked in this file — test it directly.
    const { applySchema } = await import('../../../src/db/schema.js');
    const result = { records: [] } as unknown as Result;
    const { session, runSpy } = makeMockSession(result);
    const driver = makeMockDriver(session);

    await applySchema(driver);

    const allQueries = (runSpy.mock.calls as [string][]).map(([q]) => q);
    const indexQuery = allQueries.find((q) => q.includes('trackLyrics'));
    expect(indexQuery).toBeDefined();
    expect(indexQuery).toContain('Track');
  });
});
