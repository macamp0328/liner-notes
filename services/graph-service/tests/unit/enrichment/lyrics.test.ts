import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichLyrics } from '../../../src/enrichment/lyrics.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — factories run before module-level vi.mock() calls resolve.
// ---------------------------------------------------------------------------
const mockGetUnenrichedTracks = vi.hoisted(() => vi.fn());
const mockSetTrackLyrics = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/lyrics-repository.js', () => ({
  getUnenrichedTracks: mockGetUnenrichedTracks,
  setTrackLyrics: mockSetTrackLyrics,
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

const sampleTrack = {
  title: 'Song Title',
  position: 'A1',
  releaseDiscogsId: 13570466,
  artistName: 'Test Artist',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('enrichLyrics', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['GENIUS_TOKEN'];

    mockGetUnenrichedTracks.mockResolvedValue([]);
    mockSetTrackLyrics.mockResolvedValue(undefined);

    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  // -------------------------------------------------------------------------
  // Empty tracks
  // -------------------------------------------------------------------------
  it('returns zero counts when no tracks need enrichment', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([]);

    const summary = await enrichLyrics(fakeDriver);

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

    const summary = await enrichLyrics(fakeDriver);

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
    );
  });

  // -------------------------------------------------------------------------
  // LRCLIB 404 — no Genius token
  // -------------------------------------------------------------------------
  it('skips track when LRCLIB returns 404 and no GENIUS_TOKEN is set', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // Only one fetch call — no Genius fallback
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // LRCLIB network error
  // -------------------------------------------------------------------------
  it('increments failed when LRCLIB throws a network error', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockRejectedValueOnce(new Error('Network failure'));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // LRCLIB non-404 error status
  // -------------------------------------------------------------------------
  it('increments failed when LRCLIB returns an unexpected non-200 status', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 500));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.failed).toBe(1);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius fallback — success
  // -------------------------------------------------------------------------
  it('falls back to Genius and enriches when LRCLIB returns 404 and GENIUS_TOKEN is set', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const geniusLyricsHtml = '<div data-lyrics-container="true">Hello<br/>World</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(geniusLyricsHtml)); // Genius HTML page

    const summary = await enrichLyrics(fakeDriver);

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
    );
  });

  // -------------------------------------------------------------------------
  // Genius fallback — no search hits
  // -------------------------------------------------------------------------
  it('skips track when Genius search returns no hits', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const emptySearch = { meta: { status: 200 }, response: { hits: [] } };
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(emptySearch)); // Genius search no hits

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // No third fetch — no page to scrape when there are no hits
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Genius skipped when no token
  // -------------------------------------------------------------------------
  it('does not call Genius when GENIUS_TOKEN is not set', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404)); // only LRCLIB called

    const summary = await enrichLyrics(fakeDriver);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Genius network error
  // -------------------------------------------------------------------------
  it('increments failed when Genius search throws a network error', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockRejectedValueOnce(new Error('Genius network error'));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius HTML with no lyrics containers
  // -------------------------------------------------------------------------
  it('skips track when Genius page contains no data-lyrics-container divs', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse('<html><body>No lyrics here</body></html>'));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Mixed results — summary counts
  // -------------------------------------------------------------------------
  it('counts enriched, skipped, and failed correctly across multiple tracks', async () => {
    const track1 = { ...sampleTrack, position: 'A1', title: 'Track 1' };
    const track2 = { ...sampleTrack, position: 'A2', title: 'Track 2' };
    const track3 = { ...sampleTrack, position: 'A3', title: 'Track 3' };
    mockGetUnenrichedTracks.mockResolvedValue([track1, track2, track3]);

    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)) // track1: LRCLIB hit
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // track2: LRCLIB 404, no token → skip
      .mockRejectedValueOnce(new Error('Network failure')); // track3: LRCLIB throws

    const summary = await enrichLyrics(fakeDriver);

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

    await enrichLyrics(fakeDriver);

    const [lrclibUrl] = fetchSpy.mock.calls[0] as [string];
    expect(lrclibUrl).toContain('artist_name=');
    expect(mockSetTrackLyrics).toHaveBeenCalledOnce();
  });
});
