import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichArtistProfiles } from '../../../src/enrichment/artist-profiles.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedArtists = vi.hoisted(() => vi.fn());
const mockSetArtistProfile = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-profiles-repository.js', () => ({
  getUnenrichedArtists: mockGetUnenrichedArtists,
  setArtistProfile: mockSetArtistProfile,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeClient(
  getArtistImpl?: (id: number) => Promise<{
    id: number;
    name: string;
    realname?: string;
    profile?: string;
  }>,
) {
  return {
    getArtist: getArtistImpl
      ? vi.fn().mockImplementation(getArtistImpl)
      : vi.fn().mockResolvedValue({
          id: 1,
          name: 'Test Artist',
          realname: 'John Smith',
          profile: 'A musician from New York.',
        }),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichArtistProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedArtists.mockResolvedValue([]);
    mockSetArtistProfile.mockResolvedValue(undefined);
  });

  it('returns zero counts when no artists need enrichment', async () => {
    const client = makeClient();

    const summary = await enrichArtistProfiles(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.getArtist).not.toHaveBeenCalled();
  });

  it('fetches profile and sets realName + profile for each unenriched artist', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 42 }]);
    const client = makeClient();

    const summary = await enrichArtistProfiles(client, fakeDriver);

    expect(client.getArtist).toHaveBeenCalledWith(42);
    expect(mockSetArtistProfile).toHaveBeenCalledWith(
      fakeDriver,
      42,
      'John Smith',
      'A musician from New York.',
    );
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('skips (stores nulls) when profile and realname are both absent', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 99 }]);
    const client = makeClient(async () => ({ id: 99, name: 'No Data Artist' }));

    const summary = await enrichArtistProfiles(client, fakeDriver);

    expect(mockSetArtistProfile).toHaveBeenCalledWith(fakeDriver, 99, null, null);
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('counts failures per artist and continues processing', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 1 }, { discogsId: 2 }]);

    const client = {
      getArtist: vi
        .fn()
        .mockRejectedValueOnce(new Error('Discogs API error 503'))
        .mockResolvedValueOnce({ id: 2, name: 'Artist B', realname: 'B Real', profile: 'Bio' }),
    } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;

    const summary = await enrichArtistProfiles(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetArtistProfile).toHaveBeenCalledTimes(1);
    expect(mockSetArtistProfile).toHaveBeenCalledWith(fakeDriver, 2, 'B Real', 'Bio');
  });

  it('treats empty string profile/realname as null', async () => {
    mockGetUnenrichedArtists.mockResolvedValue([{ discogsId: 77 }]);
    const client = makeClient(async () => ({
      id: 77,
      name: 'Empty Artist',
      realname: '   ',
      profile: '',
    }));

    const summary = await enrichArtistProfiles(client, fakeDriver);

    expect(mockSetArtistProfile).toHaveBeenCalledWith(fakeDriver, 77, null, null);
    expect(summary.skipped).toBe(1);
  });
});
