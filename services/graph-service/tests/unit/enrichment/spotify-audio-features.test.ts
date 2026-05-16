import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichSpotifyIds } from '../../../src/enrichment/spotify-audio-features.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetTracksForSpotifyEnrichment = vi.hoisted(() => vi.fn());
const mockSetTrackSpotifyId = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/spotify-audio-repository.js', () => ({
  getTracksForSpotifyEnrichment: mockGetTracksForSpotifyEnrichment,
  setTrackSpotifyId: mockSetTrackSpotifyId,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

const sampleTrack = {
  title: 'Test Song',
  position: 'A1',
  releaseDiscogsId: 12345,
  artistName: 'Test Artist',
  durationSeconds: 200,
};

function makeClient(overrides: { searchTrack?: ReturnType<typeof vi.fn> } = {}) {
  return {
    searchTrack:
      overrides.searchTrack ??
      vi.fn().mockResolvedValue([{ id: 'spotify-track-id-1', durationMs: 200_000 }]),
  } as unknown as import('../../../src/ingestion/spotify-client.js').SpotifyClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichSpotifyIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([]);
    mockSetTrackSpotifyId.mockResolvedValue(undefined);
  });

  it('returns zero counts when no tracks need enrichment', async () => {
    const client = makeClient();

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.searchTrack).not.toHaveBeenCalled();
  });

  it('stores spotifyId with high confidence when duration is within 2s', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'spotify-track-id-1', durationMs: 200_500 }, // 0.5s off → high
      ]),
    });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(client.searchTrack).toHaveBeenCalledWith('Test Artist', 'Test Song');
    expect(mockSetTrackSpotifyId).toHaveBeenCalledWith(
      fakeDriver,
      12345,
      'A1',
      'spotify-track-id-1',
      'high',
    );
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('stores spotifyId with medium confidence when duration is between 2s and 5s', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'spotify-track-id-1', durationMs: 203_500 }, // 3.5s off → medium
      ]),
    });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(mockSetTrackSpotifyId).toHaveBeenCalledWith(
      fakeDriver,
      12345,
      'A1',
      'spotify-track-id-1',
      'medium',
    );
    expect(summary.enriched).toBe(1);
  });

  it('skips a track when no candidate is within 5s of the track duration', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'spotify-track-id-1', durationMs: 210_000 }, // 10s off → skip
      ]),
    });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(mockSetTrackSpotifyId).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('skips a track when Spotify search returns no candidates', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({ searchTrack: vi.fn().mockResolvedValue([]) });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(mockSetTrackSpotifyId).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('increments failed when searchTrack throws', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockRejectedValue(new Error('network error')),
    });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('increments failed when setTrackSpotifyId throws', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);
    mockSetTrackSpotifyId.mockRejectedValue(new Error('neo4j write error'));

    const client = makeClient();

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('picks the closest duration candidate among multiple results', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([{ ...sampleTrack, durationSeconds: 200 }]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'far-id', durationMs: 210_000 }, // 10s off
        { id: 'close-id', durationMs: 201_000 }, // 1s off → winner
        { id: 'medium-id', durationMs: 204_000 }, // 4s off
      ]),
    });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(mockSetTrackSpotifyId).toHaveBeenCalledWith(fakeDriver, 12345, 'A1', 'close-id', 'high');
    expect(summary.enriched).toBe(1);
  });

  it('uses empty string artist name when artistName is null', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([{ ...sampleTrack, artistName: null }]);

    const client = makeClient();

    await enrichSpotifyIds(client, fakeDriver);

    expect(client.searchTrack).toHaveBeenCalledWith('', 'Test Song');
  });

  it('handles multiple tracks independently', async () => {
    const track2 = { ...sampleTrack, position: 'A2', releaseDiscogsId: 99999 };
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack, track2]);

    const client = makeClient({
      searchTrack: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'id-1', durationMs: 200_000 }])
        .mockResolvedValueOnce([{ id: 'id-2', durationMs: 200_000 }]),
    });

    const summary = await enrichSpotifyIds(client, fakeDriver);

    expect(mockSetTrackSpotifyId).toHaveBeenCalledTimes(2);
    expect(summary.enriched).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });
});
