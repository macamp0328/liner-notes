import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichNationality } from '../../../src/enrichment/artist-nationality.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedArtists = vi.hoisted(() => vi.fn());
const mockGetUnenrichedMusicians = vi.hoisted(() => vi.fn());
const mockSetArtistNationality = vi.hoisted(() => vi.fn());
const mockSetMusicianNationality = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-nationality-repository.js', () => ({
  getUnenrichedArtistsForNationality: mockGetUnenrichedArtists,
  getUnenrichedMusiciansForNationality: mockGetUnenrichedMusicians,
  setArtistNationality: mockSetArtistNationality,
  setMusicianNationality: mockSetMusicianNationality,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMbClient(
  byDiscogsId: (id: number) => Promise<string | null> = async () => null,
  byName: (name: string) => Promise<string | null> = async () => null,
) {
  return {
    getCountryByDiscogsId: vi.fn().mockImplementation(byDiscogsId),
    getCountryByName: vi.fn().mockImplementation(byName),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

function makeWdClient(
  byDiscogsId: (id: number) => Promise<string | null> = async () => null,
  byWikipediaUrl: (url: string) => Promise<string | null> = async () => null,
) {
  return {
    getCountryByDiscogsId: vi.fn().mockImplementation(byDiscogsId),
    getCountryByWikipediaUrl: vi.fn().mockImplementation(byWikipediaUrl),
  } as unknown as import('../../../src/ingestion/wikidata-client.js').WikidataClient;
}

function makeDiscogsClient(
  getArtist: (id: number) => Promise<{ urls?: string[] }> = async () => ({ urls: [] }),
) {
  return {
    getArtist: vi.fn().mockImplementation(getArtist),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichNationality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedArtists.mockResolvedValue([]);
    mockGetUnenrichedMusicians.mockResolvedValue([]);
    mockSetArtistNationality.mockResolvedValue(undefined);
    mockSetMusicianNationality.mockResolvedValue(undefined);
  });

  it('returns zero counts when nothing needs enrichment', async () => {
    const client = makeMbClient();
    const summary = await enrichNationality(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('enriches an artist with a found country code', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1 }]);
    const client = makeMbClient(async () => 'US');

    const summary = await enrichNationality(client, fakeDriver);

    expect(client.getCountryByDiscogsId).toHaveBeenCalledWith(1);
    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 1, 'US', 'musicbrainz');
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    // Per-source breakdown attributes the one resolution to MusicBrainz.
    expect(summary.resolvedByMusicbrainz).toBe(1);
    expect(summary.resolvedByWikidata).toBe(0);
  });

  it('counts skipped when country is not found for an artist', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 2 }]);
    const client = makeMbClient(async () => null);

    const summary = await enrichNationality(client, fakeDriver);

    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 2, null, null);
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('reports a progress denominator that grows when the musician phase begins', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1 }]);
    mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 10, name: 'Ron Carter' }]);
    const client = makeMbClient(async () => 'US');
    const onProgress = vi.fn();

    await enrichNationality(client, fakeDriver, undefined, undefined, undefined, onProgress);

    // Starts with the artist count only...
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 1);
    // ...then the denominator jumps to include musicians once that phase is fetched.
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it('enriches a musician with a discogsId via getCountryByDiscogsId', async () => {
    mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 10, name: 'Ron Carter' }]);
    const client = makeMbClient(async () => 'US');

    await enrichNationality(client, fakeDriver);

    expect(client.getCountryByDiscogsId).toHaveBeenCalledWith(10);
    expect(client.getCountryByName).not.toHaveBeenCalled();
    expect(mockSetMusicianNationality).toHaveBeenCalledWith(
      fakeDriver,
      { discogsId: 10, name: 'Ron Carter' },
      'US',
      'musicbrainz',
    );
  });

  it('enriches a musician without discogsId via MB name search', async () => {
    mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: null, name: 'Jack DeJohnette' }]);
    const client = makeMbClient(
      async () => null,
      async () => 'US',
    );
    const wd = makeWdClient(async () => 'CA');

    await enrichNationality(client, fakeDriver, undefined, wd);

    expect(client.getCountryByDiscogsId).not.toHaveBeenCalled();
    expect(client.getCountryByName).toHaveBeenCalledWith('Jack DeJohnette');
    // Wikidata is not called for name-only musicians (no Discogs ID to look up by)
    expect(wd.getCountryByDiscogsId).not.toHaveBeenCalled();
    expect(mockSetMusicianNationality).toHaveBeenCalledWith(
      fakeDriver,
      { discogsId: null, name: 'Jack DeJohnette' },
      'US',
      'musicbrainz',
    );
  });

  it('counts failures per artist and continues', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1 }, { discogsId: 2 }]);
    const client = {
      getCountryByDiscogsId: vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce('DE'),
      getCountryByName: vi.fn(),
    } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;

    const summary = await enrichNationality(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetArtistNationality).toHaveBeenCalledTimes(1);
    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 2, 'DE', 'musicbrainz');
  });

  it('returns failed=1 when getUnenrichedArtistsForNationality throws', async () => {
    mockGetUnenrichedArtists.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichNationality(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(client.getCountryByDiscogsId).not.toHaveBeenCalled();
    // The early error-return still carries a fully-zeroed instrumentation block so the
    // all-fields-required response schema serializes cleanly.
    expect(summary).toMatchObject({
      resolvedByMusicbrainz: 0,
      resolvedByWikidata: 0,
    });
  });

  it('still runs the musician group when the artist candidate fetch throws', async () => {
    // Group isolation (#222): a failure fetching one group's candidates counts as failed
    // but no longer aborts the other group — symmetric with the musician-fetch case.
    mockGetUnenrichedArtists.mockRejectedValue(new Error('DB connection lost'));
    mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 2, name: 'Musician B' }]);
    const client = makeMbClient(async () => 'FR');

    const summary = await enrichNationality(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetMusicianNationality).toHaveBeenCalledWith(
      fakeDriver,
      { discogsId: 2, name: 'Musician B' },
      'FR',
      'musicbrainz',
    );
  });

  it('is idempotent — second call enriches zero because repo returns empty', async () => {
    const client = makeMbClient();

    const first = await enrichNationality(client, fakeDriver);
    const second = await enrichNationality(client, fakeDriver);

    expect(first.enriched).toBe(0);
    expect(second.enriched).toBe(0);
    expect(mockSetArtistNationality).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Musician group (covers producers/engineers too — they are Musician nodes)
  // ---------------------------------------------------------------------------

  describe('Musician group resilience', () => {
    it('counts failed and continues when the musician group fetch throws', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1, name: 'Artist A' }]);
      mockGetUnenrichedMusicians.mockRejectedValue(new Error('DB timeout'));
      const client = makeMbClient(async () => 'US');

      const summary = await enrichNationality(client, fakeDriver);

      // Artist still enriched; the musician group fetch failure is counted, not thrown.
      expect(summary.enriched).toBe(1);
      expect(summary.failed).toBe(1);
      expect(mockSetMusicianNationality).not.toHaveBeenCalled();
    });

    it('aggregates counts across artist and musician groups', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1, name: 'Artist A' }]);
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 2, name: 'Musician B' }]);
      const client = makeMbClient(async () => 'FR');

      const summary = await enrichNationality(client, fakeDriver);

      expect(summary.enriched).toBe(2);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // No-Discogs-ID nodes (MusicBrainz name search only)
  // ---------------------------------------------------------------------------

  describe('No-Discogs-ID nodes', () => {
    it('resolves a no-ID musician via MB name search and tags it musicbrainz', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([
        { discogsId: null, name: 'No ID Musician Found by MB' },
      ]);
      const client = makeMbClient(
        async () => null,
        async () => 'DE',
      );

      await enrichNationality(client, fakeDriver);

      expect(client.getCountryByName).toHaveBeenCalled();
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        expect.objectContaining({ discogsId: null }),
        'DE',
        'musicbrainz',
      );
    });

    it('skips when MB name search returns null for no-ID musician', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: null, name: 'No ID Musician' }]);
      const client = makeMbClient(
        async () => null,
        async () => null,
      );

      const summary = await enrichNationality(client, fakeDriver);

      expect(summary.skipped).toBe(1);
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: null, name: 'No ID Musician' },
        null,
        null,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Wikidata integration
  // ---------------------------------------------------------------------------

  describe('Wikidata fallback and conflict resolution', () => {
    it('uses Wikidata country when MusicBrainz returns null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 5, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => 'JP');

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 5, 'JP', 'wikidata');
      expect(summary.enriched).toBe(1);
      expect(summary.resolvedByWikidata).toBe(1);
      expect(summary.resolvedByMusicbrainz).toBe(0);
    });

    it('uses MusicBrainz country when both agree', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 6, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => 'GB');
      const wd = makeWdClient(async () => 'GB');

      await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 6, 'GB', 'musicbrainz');
    });

    it('prefers Wikidata when sources conflict and includes artist name in log', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 7, name: 'Miles Davis' }]);
      const mb = makeMbClient(async () => 'US');
      const wd = makeWdClient(async () => 'GB');
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await enrichNationality(mb, fakeDriver, logger, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 7, 'GB', 'wikidata');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('MB=US WD=GB'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"Miles Davis"'));
    });

    it('skips when both MB and Wikidata return null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 8, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 8, null, null);
      expect(summary.skipped).toBe(1);
    });

    it('works without Wikidata client (backward compatible)', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 9, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => 'FR');

      const summary = await enrichNationality(mb, fakeDriver);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 9, 'FR', 'musicbrainz');
      expect(summary.enriched).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Source 2: Wikidata via Wikipedia URL (Discogs artist page)
  // ---------------------------------------------------------------------------

  describe('Source 2 — Wikidata via Wikipedia URL', () => {
    it('uses Wikipedia URL fallback when MB+WD by Discogs ID both return null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 20, name: 'Pino Palladino' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(
        async () => null,
        async () => 'IT',
      );
      const dc = makeDiscogsClient(async () => ({
        urls: ['https://en.wikipedia.org/wiki/Pino_Palladino'],
      }));

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd, dc);

      expect(dc.getArtist).toHaveBeenCalledWith(20);
      expect(wd.getCountryByWikipediaUrl).toHaveBeenCalledWith(
        'https://en.wikipedia.org/wiki/Pino_Palladino',
      );
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 20, 'IT', 'wikidata');
      expect(summary.enriched).toBe(1);
    });

    it('does not call Discogs when source 1 already found a result', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 21, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => 'GB');
      const wd = makeWdClient(async () => null);
      const dc = makeDiscogsClient();

      await enrichNationality(mb, fakeDriver, undefined, wd, dc);

      expect(dc.getArtist).not.toHaveBeenCalled();
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 21, 'GB', 'musicbrainz');
    });

    it('skips Wikipedia fallback when no discogsClient is provided', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 22, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(wd.getCountryByWikipediaUrl).not.toHaveBeenCalled();
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 22, null, null);
      expect(summary.skipped).toBe(1);
    });

    it('skips Wikipedia fallback when artist has no Wikipedia URLs', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 23, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);
      const dc = makeDiscogsClient(async () => ({ urls: ['https://www.allmusic.com/artist/xyz'] }));

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd, dc);

      expect(wd.getCountryByWikipediaUrl).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(1);
    });

    it('uses the first Wikipedia URL that returns a non-null result', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 24, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(
        async () => null,
        vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('SE'),
      );
      const dc = makeDiscogsClient(async () => ({
        urls: [
          'https://en.wikipedia.org/wiki/First_Article',
          'https://en.wikipedia.org/wiki/Second_Article',
        ],
      }));

      await enrichNationality(mb, fakeDriver, undefined, wd, dc);

      expect(wd.getCountryByWikipediaUrl).toHaveBeenCalledTimes(2);
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 24, 'SE', 'wikidata');
    });

    it('skips when the Wikipedia lookup also returns null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 25, name: 'Some Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(
        async () => null,
        async () => null,
      );
      const dc = makeDiscogsClient(async () => ({
        urls: ['https://en.wikipedia.org/wiki/Some_Artist'],
      }));

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd, dc);

      expect(wd.getCountryByWikipediaUrl).toHaveBeenCalled();
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 25, null, null);
      expect(summary.skipped).toBe(1);
    });
  });
});
