import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
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
  let fetchSpy: MockInstance<typeof fetch>;

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

  // -------------------------------------------------------------------------
  // Genius — type !== 'song' guard
  // -------------------------------------------------------------------------
  it('skips track when Genius search hit type is not song', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
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

    const summary = await enrichLyrics(fakeDriver);

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
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
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

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
    // No page fetch — artist guard fired before fetching the page
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Genius — garbage content guard (header prefix leaked via nested div)
  // -------------------------------------------------------------------------
  it('skips track when extracted Genius lyrics start with contributor header', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    // Simulates Genius page where a header div nests inside the lyrics container.
    // The balanced-bracket extractor captures the full outer div content including
    // the header text, which isValidGeniusLyrics then rejects.
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

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius — oversized content guard (book / article scraped)
  // -------------------------------------------------------------------------
  it('skips track when Genius page returns content exceeding 15,000 characters', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const oversizedContent = 'A'.repeat(15_001);
    const oversizedHtml = `<div data-lyrics-container="true">${oversizedContent}</div>`;
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(oversizedHtml));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(mockSetTrackLyrics).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Genius — HTML entity decoding
  // -------------------------------------------------------------------------
  it('stores lyrics with HTML entities decoded', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const entityHtml = '<div data-lyrics-container="true">I&#x27;ll never leave you &amp; me</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(entityHtml));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(1);
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      "I'll never leave you & me",
      'genius',
    );
  });

  // -------------------------------------------------------------------------
  // Genius — multiple lyrics containers joined
  // -------------------------------------------------------------------------
  it('joins multiple data-lyrics-container divs with double newline', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const multiHtml = `
      <div data-lyrics-container="true">Verse 1</div>
      <div data-lyrics-container="true">Chorus</div>
    `;
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(multiHtml));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(1);
    expect(mockSetTrackLyrics).toHaveBeenCalledWith(
      fakeDriver,
      sampleTrack.releaseDiscogsId,
      sampleTrack.position,
      'Verse 1\n\nChorus',
      'genius',
    );
  });

  // -------------------------------------------------------------------------
  // Initial query failure — returns a failed summary instead of throwing (#151)
  // -------------------------------------------------------------------------
  it('returns a failed summary (does not throw) when the initial track query fails', async () => {
    mockGetUnenrichedTracks.mockRejectedValue(new Error('Neo4j unavailable'));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // LRCLIB write failure — counts failed and continues to the next track (#151)
  // -------------------------------------------------------------------------
  it('counts failed and continues when the LRCLIB lyrics write throws', async () => {
    const track1 = { ...sampleTrack, position: 'A1', title: 'Track 1' };
    const track2 = { ...sampleTrack, position: 'A2', title: 'Track 2' };
    mockGetUnenrichedTracks.mockResolvedValue([track1, track2]);

    fetchSpy
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)) // track1: LRCLIB hit → write throws
      .mockResolvedValueOnce(makeOkResponse(lrclibHit)); // track2: LRCLIB hit → write succeeds
    mockSetTrackLyrics
      .mockRejectedValueOnce(new Error('Neo4j write failed')) // track1 write
      .mockResolvedValueOnce(undefined); // track2 write

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    // Both tracks attempted a write — the first throw did not abort the loop
    expect(mockSetTrackLyrics).toHaveBeenCalledTimes(2);
  });
});
