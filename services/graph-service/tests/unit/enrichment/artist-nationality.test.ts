import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichNationality } from '../../../src/enrichment/artist-nationality.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedArtists = vi.hoisted(() => vi.fn());
const mockGetUnenrichedMusicians = vi.hoisted(() => vi.fn());
const mockGetUnenrichedProducers = vi.hoisted(() => vi.fn());
const mockGetUnenrichedEngineers = vi.hoisted(() => vi.fn());
const mockSetArtistNationality = vi.hoisted(() => vi.fn());
const mockSetMusicianNationality = vi.hoisted(() => vi.fn());
const mockSetProducerNationality = vi.hoisted(() => vi.fn());
const mockSetEngineerNationality = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-nationality-repository.js', () => ({
  getUnenrichedArtistsForNationality: mockGetUnenrichedArtists,
  getUnenrichedMusiciansForNationality: mockGetUnenrichedMusicians,
  getUnenrichedProducersForNationality: mockGetUnenrichedProducers,
  getUnenrichedEngineersForNationality: mockGetUnenrichedEngineers,
  setArtistNationality: mockSetArtistNationality,
  setMusicianNationality: mockSetMusicianNationality,
  setProducerNationality: mockSetProducerNationality,
  setEngineerNationality: mockSetEngineerNationality,
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

function makeViafClient(byName: (name: string) => Promise<string | null> = async () => null) {
  return {
    getCountryByName: vi.fn().mockImplementation(byName),
  } as unknown as import('../../../src/ingestion/viaf-client.js').VIAFClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichNationality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedArtists.mockResolvedValue([]);
    mockGetUnenrichedMusicians.mockResolvedValue([]);
    mockGetUnenrichedProducers.mockResolvedValue([]);
    mockGetUnenrichedEngineers.mockResolvedValue([]);
    mockSetArtistNationality.mockResolvedValue(undefined);
    mockSetMusicianNationality.mockResolvedValue(undefined);
    mockSetProducerNationality.mockResolvedValue(undefined);
    mockSetEngineerNationality.mockResolvedValue(undefined);
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
    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 1, 'US');
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('counts skipped when country is not found for an artist', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 2 }]);
    const client = makeMbClient(async () => null);

    const summary = await enrichNationality(client, fakeDriver);

    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 2, null);
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
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
    );
  });

  it('enriches a musician without discogsId via MB name search then VIAF fallback', async () => {
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
    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 2, 'DE');
  });

  it('returns failed=1 when getUnenrichedArtistsForNationality throws', async () => {
    mockGetUnenrichedArtists.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichNationality(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(client.getCountryByDiscogsId).not.toHaveBeenCalled();
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
  // Producer and Engineer nodes
  // ---------------------------------------------------------------------------

  describe('Producer and Engineer enrichment', () => {
    it('enriches a producer with a discogsId', async () => {
      mockGetUnenrichedProducers.mockResolvedValue([{ discogsId: 50, name: 'Rick Rubin' }]);
      const client = makeMbClient(async () => 'US');

      const summary = await enrichNationality(client, fakeDriver);

      expect(client.getCountryByDiscogsId).toHaveBeenCalledWith(50);
      expect(mockSetProducerNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: 50, name: 'Rick Rubin' },
        'US',
      );
      expect(summary.enriched).toBe(1);
    });

    it('enriches a producer without discogsId via MB then VIAF', async () => {
      mockGetUnenrichedProducers.mockResolvedValue([{ discogsId: null, name: 'Joe Meek' }]);
      const client = makeMbClient(
        async () => null,
        async () => null,
      );
      const viaf = makeViafClient(async () => 'GB');

      await enrichNationality(client, fakeDriver, undefined, undefined, undefined, viaf);

      expect(client.getCountryByName).toHaveBeenCalledWith('Joe Meek');
      expect(viaf.getCountryByName).toHaveBeenCalledWith('Joe Meek');
      expect(mockSetProducerNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: null, name: 'Joe Meek' },
        'GB',
      );
    });

    it('enriches an engineer with a discogsId', async () => {
      mockGetUnenrichedEngineers.mockResolvedValue([{ discogsId: 60, name: 'Rudy Van Gelder' }]);
      const client = makeMbClient(async () => 'US');

      const summary = await enrichNationality(client, fakeDriver);

      expect(client.getCountryByDiscogsId).toHaveBeenCalledWith(60);
      expect(mockSetEngineerNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: 60, name: 'Rudy Van Gelder' },
        'US',
      );
      expect(summary.enriched).toBe(1);
    });

    it('enriches an engineer without discogsId via MB then VIAF', async () => {
      mockGetUnenrichedEngineers.mockResolvedValue([{ discogsId: null, name: 'Tom Dowd' }]);
      const client = makeMbClient(
        async () => null,
        async () => 'US',
      );

      const summary = await enrichNationality(client, fakeDriver);

      expect(client.getCountryByName).toHaveBeenCalledWith('Tom Dowd');
      expect(mockSetEngineerNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: null, name: 'Tom Dowd' },
        'US',
      );
      expect(summary.enriched).toBe(1);
    });

    it('continues enriching other groups when one group fetch fails', async () => {
      mockGetUnenrichedMusicians.mockRejectedValue(new Error('DB timeout'));
      mockGetUnenrichedProducers.mockResolvedValue([{ discogsId: 50, name: 'Rick Rubin' }]);
      const client = makeMbClient(async () => 'US');

      const summary = await enrichNationality(client, fakeDriver);

      expect(summary.failed).toBe(1);
      expect(summary.enriched).toBe(1);
      expect(mockSetProducerNationality).toHaveBeenCalledWith(fakeDriver, expect.anything(), 'US');
    });

    it('aggregates counts across all four node types', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1, name: 'Artist A' }]);
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 2, name: 'Musician B' }]);
      mockGetUnenrichedProducers.mockResolvedValue([{ discogsId: 3, name: 'Producer C' }]);
      mockGetUnenrichedEngineers.mockResolvedValue([{ discogsId: 4, name: 'Engineer D' }]);
      const client = makeMbClient(async () => 'FR');

      const summary = await enrichNationality(client, fakeDriver);

      expect(summary.enriched).toBe(4);
      expect(summary.skipped).toBe(0);
      expect(summary.failed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // No-Discogs-ID VIAF fallback
  // ---------------------------------------------------------------------------

  describe('VIAF fallback for no-Discogs-ID nodes', () => {
    it('calls VIAF after MB name search for a musician without discogsId', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: null, name: 'No ID Musician' }]);
      const client = makeMbClient(
        async () => null,
        async () => null,
      );
      const viaf = makeViafClient(async () => 'FR');

      await enrichNationality(client, fakeDriver, undefined, undefined, undefined, viaf);

      expect(client.getCountryByName).toHaveBeenCalledWith('No ID Musician');
      expect(viaf.getCountryByName).toHaveBeenCalledWith('No ID Musician');
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: null, name: 'No ID Musician' },
        'FR',
      );
    });

    it('does not call VIAF when MB name search already found a result for no-ID musician', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([
        { discogsId: null, name: 'No ID Musician Found by MB' },
      ]);
      const client = makeMbClient(
        async () => null,
        async () => 'DE',
      );
      const viaf = makeViafClient(async () => 'FR');

      await enrichNationality(client, fakeDriver, undefined, undefined, undefined, viaf);

      expect(client.getCountryByName).toHaveBeenCalled();
      expect(viaf.getCountryByName).not.toHaveBeenCalled();
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        expect.objectContaining({ discogsId: null }),
        'DE',
      );
    });

    it('skips VIAF when viafClient is not provided for no-ID musician', async () => {
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

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 5, 'JP');
      expect(summary.enriched).toBe(1);
    });

    it('uses MusicBrainz country when both agree', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 6, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => 'GB');
      const wd = makeWdClient(async () => 'GB');

      await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 6, 'GB');
    });

    it('prefers Wikidata when sources conflict and includes artist name in log', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 7, name: 'Miles Davis' }]);
      const mb = makeMbClient(async () => 'US');
      const wd = makeWdClient(async () => 'GB');
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await enrichNationality(mb, fakeDriver, logger, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 7, 'GB');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('MB=US WD=GB'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"Miles Davis"'));
    });

    it('skips when both MB and Wikidata return null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 8, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 8, null);
      expect(summary.skipped).toBe(1);
    });

    it('works without Wikidata client (backward compatible)', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 9, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => 'FR');

      const summary = await enrichNationality(mb, fakeDriver);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 9, 'FR');
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
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 20, 'IT');
      expect(summary.enriched).toBe(1);
    });

    it('does not call Discogs when source 1 already found a result', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 21, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => 'GB');
      const wd = makeWdClient(async () => null);
      const dc = makeDiscogsClient();

      await enrichNationality(mb, fakeDriver, undefined, wd, dc);

      expect(dc.getArtist).not.toHaveBeenCalled();
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 21, 'GB');
    });

    it('skips Wikipedia fallback when no discogsClient is provided', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 22, name: 'Test Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd);

      expect(wd.getCountryByWikipediaUrl).not.toHaveBeenCalled();
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 22, null);
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
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 24, 'SE');
    });

    it('proceeds to VIAF when Wikipedia lookup also returns null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 25, name: 'Some Artist' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(
        async () => null,
        async () => null,
      );
      const dc = makeDiscogsClient(async () => ({
        urls: ['https://en.wikipedia.org/wiki/Some_Artist'],
      }));
      const viaf = makeViafClient(async () => 'NO');

      await enrichNationality(mb, fakeDriver, undefined, wd, dc, viaf);

      expect(wd.getCountryByWikipediaUrl).toHaveBeenCalled();
      expect(viaf.getCountryByName).toHaveBeenCalled();
      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 25, 'NO');
    });
  });

  // ---------------------------------------------------------------------------
  // Source 3: VIAF name search (with Discogs ID — last resort)
  // ---------------------------------------------------------------------------

  describe('Source 3 — VIAF name search', () => {
    it('uses VIAF when all other sources return null', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 30, name: 'Jan Garbarek' }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);
      const dc = makeDiscogsClient(async () => ({ urls: [] }));
      const viaf = makeViafClient(async () => 'NO');

      const summary = await enrichNationality(mb, fakeDriver, undefined, wd, dc, viaf);

      expect(viaf.getCountryByName).toHaveBeenCalledWith('Jan Garbarek');
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: 30, name: 'Jan Garbarek' },
        'NO',
      );
      expect(summary.enriched).toBe(1);
    });

    it('does not call VIAF when an earlier source found a result', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 31, name: 'Ron Carter' }]);
      const mb = makeMbClient(async () => 'US');
      const viaf = makeViafClient(async () => 'CA');

      await enrichNationality(mb, fakeDriver, undefined, undefined, undefined, viaf);

      expect(viaf.getCountryByName).not.toHaveBeenCalled();
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: 31, name: 'Ron Carter' },
        'US',
      );
    });

    it('skips VIAF when viafClient is not provided', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 32, name: 'Someone' }]);
      const mb = makeMbClient(async () => null);

      const summary = await enrichNationality(mb, fakeDriver);

      expect(summary.skipped).toBe(1);
      expect(mockSetMusicianNationality).toHaveBeenCalledWith(
        fakeDriver,
        { discogsId: 32, name: 'Someone' },
        null,
      );
    });

    it('skips when VIAF also returns null', async () => {
      mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 33, name: 'Unknown Person' }]);
      const mb = makeMbClient(async () => null);
      const dc = makeDiscogsClient(async () => ({ urls: [] }));
      const viaf = makeViafClient(async () => null);

      const summary = await enrichNationality(mb, fakeDriver, undefined, undefined, dc, viaf);

      expect(viaf.getCountryByName).toHaveBeenCalledWith('Unknown Person');
      expect(summary.skipped).toBe(1);
    });
  });
});
