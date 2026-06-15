import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichArtistMusicbrainzIds } from '../../../src/enrichment/artist-musicbrainz-id.js';

const mockGetArtists = vi.hoisted(() => vi.fn());
const mockGetMusicians = vi.hoisted(() => vi.fn());
const mockSetArtist = vi.hoisted(() => vi.fn());
const mockSetMusician = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-musicbrainz-id-repository.js', () => ({
  getUnenrichedArtistsForMbid: mockGetArtists,
  getUnenrichedMusiciansForMbid: mockGetMusicians,
  setArtistMusicbrainzId: mockSetArtist,
  setMusicianMusicbrainzId: mockSetMusician,
}));

const fakeDriver = {} as Driver;

function makeClient(resolveImpl?: (discogsId: number) => Promise<string | null>) {
  return {
    resolveArtistMbidByDiscogsId: resolveImpl
      ? vi.fn().mockImplementation(resolveImpl)
      : vi.fn().mockResolvedValue(null),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

describe('enrichArtistMusicbrainzIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetArtists.mockResolvedValue([]);
    mockGetMusicians.mockResolvedValue([]);
    mockSetArtist.mockResolvedValue(undefined);
    mockSetMusician.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no candidates', async () => {
    const client = makeClient();
    const summary = await enrichArtistMusicbrainzIds(client, fakeDriver);
    expect(summary).toMatchObject({ enriched: 0, skipped: 0, failed: 0 });
    expect(client.resolveArtistMbidByDiscogsId).not.toHaveBeenCalled();
  });

  it('stores the resolved MBID on an artist and counts it enriched', async () => {
    mockGetArtists.mockResolvedValue([{ discogsId: 42, name: 'Miles Davis' }]);
    const client = makeClient(async () => 'mb-uuid-42');

    const summary = await enrichArtistMusicbrainzIds(client, fakeDriver);

    expect(client.resolveArtistMbidByDiscogsId).toHaveBeenCalledWith(42);
    expect(mockSetArtist).toHaveBeenCalledWith(fakeDriver, 42, 'mb-uuid-42');
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('throttles (stamps only) an artist with no MusicBrainz Discogs link', async () => {
    mockGetArtists.mockResolvedValue([{ discogsId: 7, name: 'Obscure' }]);
    const client = makeClient(async () => null);

    const summary = await enrichArtistMusicbrainzIds(client, fakeDriver);

    expect(mockSetArtist).toHaveBeenCalledWith(fakeDriver, 7, null);
    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('resolves musicians via the same lookup and writer', async () => {
    mockGetMusicians.mockResolvedValue([{ discogsId: 10, name: 'Ron Carter' }]);
    const client = makeClient(async () => 'mb-uuid-10');

    const summary = await enrichArtistMusicbrainzIds(client, fakeDriver);

    expect(mockSetMusician).toHaveBeenCalledWith(fakeDriver, 10, 'mb-uuid-10');
    expect(summary.enriched).toBe(1);
  });

  it('counts a fetch failure and continues to the next candidate', async () => {
    mockGetArtists.mockResolvedValue([
      { discogsId: 1, name: 'A' },
      { discogsId: 2, name: 'B' },
    ]);
    const client = {
      resolveArtistMbidByDiscogsId: vi
        .fn()
        .mockRejectedValueOnce(new Error('MB 503'))
        .mockResolvedValueOnce('mb-uuid-2'),
    } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;

    const summary = await enrichArtistMusicbrainzIds(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetArtist).toHaveBeenCalledWith(fakeDriver, 2, 'mb-uuid-2');
  });
});
