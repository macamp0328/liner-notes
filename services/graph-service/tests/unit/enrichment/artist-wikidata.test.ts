import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichArtistWikidata } from '../../../src/enrichment/artist-wikidata.js';
import type { ArtistWikidataData } from '../../../src/ingestion/wikidata-client.js';

const mockGetUnenriched = vi.hoisted(() => vi.fn());
const mockSetArtistWikidata = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-wikidata-repository.js', () => ({
  getUnenrichedArtistsForWikidata: mockGetUnenriched,
  setArtistWikidata: mockSetArtistWikidata,
}));

const fakeDriver = {} as Driver;

const DATA: ArtistWikidataData = {
  qid: 'Q1299',
  bornYear: 1941,
  bornDate: '1941-10-13',
  diedYear: null,
  diedDate: null,
  imageUrl: 'http://commons.wikimedia.org/wiki/Special:FilePath/Paul.jpg',
  awards: ['Grammy Award'],
  playsInstrument: ['guitar', 'vocals'],
  playsInstrumentRaw: ['guitar', 'vocals'],
  influencedByQids: ['Q5383'],
  memberOfQids: ['Q1299'],
  memberOfSinceYears: [1960],
  memberOfUntilYears: [1970],
};

function makeWdClient(
  byDiscogsId: (id: number) => Promise<ArtistWikidataData | null> = async () => null,
  byWikipediaUrl: (url: string) => Promise<ArtistWikidataData | null> = async () => null,
) {
  return {
    getArtistDataByDiscogsId: vi.fn().mockImplementation(byDiscogsId),
    getArtistDataByWikipediaUrl: vi.fn().mockImplementation(byWikipediaUrl),
  } as unknown as import('../../../src/ingestion/wikidata-client.js').WikidataClient;
}

function makeDiscogsClient(
  getArtist: (id: number) => Promise<{ urls?: string[] }> = async () => ({ urls: [] }),
) {
  return {
    getArtist: vi.fn().mockImplementation(getArtist),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

describe('enrichArtistWikidata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenriched.mockResolvedValue([]);
    mockSetArtistWikidata.mockResolvedValue(undefined);
  });

  it('returns zero counts when nothing needs enrichment', async () => {
    const summary = await enrichArtistWikidata(makeWdClient(), undefined, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.exhausted).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('writes the resolved bundle when the P1953 join succeeds', async () => {
    mockGetUnenriched.mockResolvedValue([{ discogsId: 470470, name: 'Paul Simon' }]);
    const wd = makeWdClient(async () => DATA);

    const summary = await enrichArtistWikidata(wd, undefined, fakeDriver);

    expect(wd.getArtistDataByDiscogsId).toHaveBeenCalledWith(470470);
    expect(mockSetArtistWikidata).toHaveBeenCalledWith(fakeDriver, 470470, DATA);
    expect(summary.enriched).toBe(1);
  });

  it('falls back to the Discogs Wikipedia URL when P1953 misses', async () => {
    mockGetUnenriched.mockResolvedValue([{ discogsId: 1, name: 'Someone' }]);
    const wd = makeWdClient(
      async () => null,
      async (url) => (url === 'https://en.wikipedia.org/wiki/Someone' ? DATA : null),
    );
    const discogs = makeDiscogsClient(async () => ({
      urls: ['https://example.com', 'https://en.wikipedia.org/wiki/Someone'],
    }));

    const summary = await enrichArtistWikidata(wd, discogs, fakeDriver);

    expect(discogs.getArtist).toHaveBeenCalledWith(1);
    expect(wd.getArtistDataByWikipediaUrl).toHaveBeenCalledWith(
      'https://en.wikipedia.org/wiki/Someone',
    );
    expect(mockSetArtistWikidata).toHaveBeenCalledWith(fakeDriver, 1, DATA);
    expect(summary.enriched).toBe(1);
  });

  it('markAttempts (skipped) when neither source resolves and there is no Discogs client', async () => {
    mockGetUnenriched.mockResolvedValue([{ discogsId: 2, name: 'Unknown' }]);

    const summary = await enrichArtistWikidata(makeWdClient(), undefined, fakeDriver);

    expect(mockSetArtistWikidata).toHaveBeenCalledWith(fakeDriver, 2, null);
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('swallows a Discogs fallback error into a throttled skip, not a failure', async () => {
    mockGetUnenriched.mockResolvedValue([{ discogsId: 3, name: 'Boom' }]);
    const discogs = makeDiscogsClient(async () => {
      throw new Error('discogs 429');
    });

    const summary = await enrichArtistWikidata(makeWdClient(), discogs, fakeDriver);

    expect(mockSetArtistWikidata).toHaveBeenCalledWith(fakeDriver, 3, null);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });
});
