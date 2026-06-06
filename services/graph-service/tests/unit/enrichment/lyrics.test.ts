import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichLyrics } from '../../../src/enrichment/lyrics.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — factories run before module-level vi.mock() calls resolve.
// ---------------------------------------------------------------------------
const mockGetUnenrichedTracks = vi.hoisted(() => vi.fn());
const mockSetTrackLyrics = vi.hoisted(() => vi.fn());
const mockMarkLyricsFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/lyrics-repository.js', () => ({
  getUnenrichedTracks: mockGetUnenrichedTracks,
  setTrackLyrics: mockSetTrackLyrics,
  markLyricsFetched: mockMarkLyricsFetched,
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
    delete process.env['GENIUS_USER_AGENT'];

    mockGetUnenrichedTracks.mockResolvedValue([]);
    mockSetTrackLyrics.mockResolvedValue(undefined);
    mockMarkLyricsFetched.mockResolvedValue(undefined);

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
    const onProgress = vi.fn();

    const summary = await enrichLyrics(fakeDriver, undefined, onProgress);

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
    // Progress is reported against the track work-list (1 track here).
    expect(onProgress).toHaveBeenCalledWith(0, 1);
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
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
    // Transient error must NOT stamp the attempt — the track retries next run.
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();
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
    // Success writes via setTrackLyrics (which stamps) — no separate mark call.
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();

    // Both Genius requests carry a browser-like User-Agent to clear Cloudflare's bot
    // check (issue #195) — without it Genius 403s datacenter IPs like the prod host.
    const searchHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(searchHeaders['Authorization']).toBe('Bearer test-genius-token');
    expect(searchHeaders['User-Agent']).toContain('Mozilla/5.0');
    expect(searchHeaders['Accept']).toBe('application/json');
    expect(searchHeaders['Accept-Language']).toContain('en');

    const pageHeaders = (fetchSpy.mock.calls[2]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(pageHeaders['User-Agent']).toContain('Mozilla/5.0');
    expect(pageHeaders['Accept']).toContain('text/html');
  });

  // -------------------------------------------------------------------------
  // Genius — GENIUS_USER_AGENT override
  // -------------------------------------------------------------------------
  it('uses the GENIUS_USER_AGENT override on both Genius requests when set', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    process.env['GENIUS_USER_AGENT'] = 'CustomAgent/9.9';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse('<div data-lyrics-container="true">Hi</div>'));

    await enrichLyrics(fakeDriver);

    const searchHeaders = (fetchSpy.mock.calls[1]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    const pageHeaders = (fetchSpy.mock.calls[2]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(searchHeaders['User-Agent']).toBe('CustomAgent/9.9');
    expect(pageHeaders['User-Agent']).toBe('CustomAgent/9.9');
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
    // Both sources empty — stamp the attempt so it's throttled, not retried every run.
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
  // Genius skipped when no token
  // -------------------------------------------------------------------------
  it('does not call Genius when GENIUS_TOKEN is not set', async () => {
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);
    fetchSpy.mockResolvedValueOnce(makeOkResponse({}, 404)); // only LRCLIB called

    const summary = await enrichLyrics(fakeDriver);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBe(1);
    // No Genius fallback and LRCLIB empty — still stamp the attempt to throttle retries.
    expect(mockMarkLyricsFetched).toHaveBeenCalledOnce();
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
    // Genius threw — transient error path must not stamp; the track retries next run.
    expect(mockMarkLyricsFetched).not.toHaveBeenCalled();
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
  // Genius — no double-unescaping (CodeQL js/double-escaping)
  // -------------------------------------------------------------------------
  it('does not double-unescape entities that decode to ampersands', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    // `&#38;` decodes to `&`. A naive chained decode would then read the resulting
    // `&lt;`/`&gt;` and turn them into `<`/`>`, reconstructing markup. A single-pass
    // decode consumes each entity once, so the text stays literal.
    const html = '<div data-lyrics-container="true">&#38;lt;b&#38;gt; stays text</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver);

    expect(summary.enriched).toBe(1);
    const stored = mockSetTrackLyrics.mock.calls[0]?.[3] as string;
    expect(stored).toBe('&lt;b&gt; stays text');
    expect(stored).not.toContain('<b>');
  });

  // -------------------------------------------------------------------------
  // Genius — strips script content (CodeQL js/incomplete-multi-character-sanitization)
  // -------------------------------------------------------------------------
  it('drops <script> blocks and their content from extracted lyrics', async () => {
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html = '<div data-lyrics-container="true">Hello<script>alert(\'x\')</script> World</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver);

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
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    const html = '<div data-lyrics-container="true">lyrics here <script and more</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver);

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
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    // Entities are decoded BEFORE tags are stripped, so `&lt;script&gt;…&lt;/script&gt;`
    // becomes a real <script> block and is removed — rather than surviving the strip and
    // being reconstructed as markup by a trailing decode.
    const html =
      '<div data-lyrics-container="true">Safe&lt;script&gt;alert(1)&lt;/script&gt; lyrics</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver);

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
    process.env['GENIUS_TOKEN'] = 'test-genius-token';
    mockGetUnenrichedTracks.mockResolvedValue([sampleTrack]);

    // The block removal runs in a fixpoint loop, so nesting cannot leave a
    // reconstructable <script> tag behind.
    const html =
      '<div data-lyrics-container="true">Safe<script><script>alert(1)</script></script> lyrics</div>';
    fetchSpy
      .mockResolvedValueOnce(makeOkResponse({}, 404)) // LRCLIB 404
      .mockResolvedValueOnce(makeOkResponse(geniusSearchHit)) // Genius search
      .mockResolvedValueOnce(makeHtmlResponse(html));

    const summary = await enrichLyrics(fakeDriver);

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
