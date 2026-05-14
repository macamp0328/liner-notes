import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichArtistNationality } from '../../../src/enrichment/artist-nationality.js';

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

function makeWdClient(byDiscogsId: (id: number) => Promise<string | null> = async () => null) {
  return {
    getCountryByDiscogsId: vi.fn().mockImplementation(byDiscogsId),
  } as unknown as import('../../../src/ingestion/wikidata-client.js').WikidataClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichArtistNationality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedArtists.mockResolvedValue([]);
    mockGetUnenrichedMusicians.mockResolvedValue([]);
    mockSetArtistNationality.mockResolvedValue(undefined);
    mockSetMusicianNationality.mockResolvedValue(undefined);
  });

  it('returns zero counts when nothing needs enrichment', async () => {
    const client = makeMbClient();
    const summary = await enrichArtistNationality(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('enriches an artist with a found country code', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1 }]);
    const client = makeMbClient(async () => 'US');

    const summary = await enrichArtistNationality(client, fakeDriver);

    expect(client.getCountryByDiscogsId).toHaveBeenCalledWith(1);
    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 1, 'US');
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('counts skipped when country is not found for an artist', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 2 }]);
    const client = makeMbClient(async () => null);

    const summary = await enrichArtistNationality(client, fakeDriver);

    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 2, null);
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('enriches a musician with a discogsId via getCountryByDiscogsId', async () => {
    mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: 10, name: 'Ron Carter' }]);
    const client = makeMbClient(async () => 'US');

    await enrichArtistNationality(client, fakeDriver);

    expect(client.getCountryByDiscogsId).toHaveBeenCalledWith(10);
    expect(client.getCountryByName).not.toHaveBeenCalled();
    expect(mockSetMusicianNationality).toHaveBeenCalledWith(
      fakeDriver,
      { discogsId: 10, name: 'Ron Carter' },
      'US',
    );
  });

  it('enriches a musician without discogsId via getCountryByName (MB only, not Wikidata)', async () => {
    mockGetUnenrichedMusicians.mockResolvedValue([{ discogsId: null, name: 'Jack DeJohnette' }]);
    const client = makeMbClient(
      async () => null,
      async () => 'US',
    );
    const wd = makeWdClient(async () => 'CA');

    await enrichArtistNationality(client, fakeDriver, undefined, wd);

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

    const summary = await enrichArtistNationality(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetArtistNationality).toHaveBeenCalledTimes(1);
    expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 2, 'DE');
  });

  it('returns failed=1 when getUnenrichedArtistsForNationality throws', async () => {
    mockGetUnenrichedArtists.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichArtistNationality(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(client.getCountryByDiscogsId).not.toHaveBeenCalled();
  });

  it('is idempotent — second call enriches zero because repo returns empty', async () => {
    const client = makeMbClient();

    const first = await enrichArtistNationality(client, fakeDriver);
    const second = await enrichArtistNationality(client, fakeDriver);

    expect(first.enriched).toBe(0);
    expect(second.enriched).toBe(0);
    expect(mockSetArtistNationality).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Wikidata integration
  // ---------------------------------------------------------------------------

  describe('Wikidata fallback and conflict resolution', () => {
    it('uses Wikidata country when MusicBrainz returns null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 5 }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => 'JP');

      const summary = await enrichArtistNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 5, 'JP');
      expect(summary.enriched).toBe(1);
    });

    it('uses MusicBrainz country when both agree', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 6 }]);
      const mb = makeMbClient(async () => 'GB');
      const wd = makeWdClient(async () => 'GB');

      await enrichArtistNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 6, 'GB');
    });

    it('prefers Wikidata when sources conflict', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 7 }]);
      const mb = makeMbClient(async () => 'US');
      const wd = makeWdClient(async () => 'GB');
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await enrichArtistNationality(mb, fakeDriver, logger, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 7, 'GB');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('MB=US WD=GB'));
    });

    it('skips when both MB and Wikidata return null', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 8 }]);
      const mb = makeMbClient(async () => null);
      const wd = makeWdClient(async () => null);

      const summary = await enrichArtistNationality(mb, fakeDriver, undefined, wd);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 8, null);
      expect(summary.skipped).toBe(1);
    });

    it('works without Wikidata client (backward compatible)', async () => {
      mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 9 }]);
      const mb = makeMbClient(async () => 'FR');

      const summary = await enrichArtistNationality(mb, fakeDriver);

      expect(mockSetArtistNationality).toHaveBeenCalledWith(fakeDriver, 9, 'FR');
      expect(summary.enriched).toBe(1);
    });
  });
});
