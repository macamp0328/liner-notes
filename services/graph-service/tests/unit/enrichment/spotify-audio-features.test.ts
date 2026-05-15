import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichSpotifyAudioFeatures } from '../../../src/enrichment/spotify-audio-features.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetTracksForSpotifyEnrichment = vi.hoisted(() => vi.fn());
const mockSetTrackAudioFeatures = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/spotify-audio-repository.js', () => ({
  getTracksForSpotifyEnrichment: mockGetTracksForSpotifyEnrichment,
  setTrackAudioFeatures: mockSetTrackAudioFeatures,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

const sampleAudioFeatures = {
  id: 'spotify-track-id-1',
  timeSignature: 4,
  tempo: 120.5,
  key: 5,
  mode: 1,
  loudness: -8.5,
  energy: 0.75,
  valence: 0.6,
  danceability: 0.7,
  acousticness: 0.1,
  instrumentalness: 0.05,
  liveness: 0.12,
  speechiness: 0.04,
};

const sampleTrack = {
  title: 'Test Song',
  position: 'A1',
  releaseDiscogsId: 12345,
  artistName: 'Test Artist',
  durationSeconds: 200,
};

function makeClient(
  overrides: {
    searchTrack?: ReturnType<typeof vi.fn>;
    getAudioFeaturesBatch?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    searchTrack:
      overrides.searchTrack ??
      vi.fn().mockResolvedValue([{ id: 'spotify-track-id-1', durationMs: 200_000 }]),
    getAudioFeaturesBatch:
      overrides.getAudioFeaturesBatch ??
      vi.fn().mockResolvedValue(new Map([['spotify-track-id-1', sampleAudioFeatures]])),
  } as unknown as import('../../../src/ingestion/spotify-client.js').SpotifyClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichSpotifyAudioFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([]);
    mockSetTrackAudioFeatures.mockResolvedValue(undefined);
  });

  it('returns zero counts when no tracks need enrichment', async () => {
    const client = makeClient();

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.searchTrack).not.toHaveBeenCalled();
    expect(client.getAudioFeaturesBatch).not.toHaveBeenCalled();
  });

  it('enriches a track with high confidence when duration is within 2s', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'spotify-track-id-1', durationMs: 200_500 }, // 0.5s off → high
      ]),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.searchTrack).toHaveBeenCalledWith('Test Artist', 'Test Song');
    expect(client.getAudioFeaturesBatch).toHaveBeenCalledWith(['spotify-track-id-1']);
    expect(mockSetTrackAudioFeatures).toHaveBeenCalledWith(
      fakeDriver,
      12345,
      'A1',
      expect.objectContaining({ id: 'spotify-track-id-1', spotifyMatchConfidence: 'high' }),
    );
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('enriches a track with medium confidence when duration is between 2s and 5s', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'spotify-track-id-1', durationMs: 203_500 }, // 3.5s off → medium
      ]),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(mockSetTrackAudioFeatures).toHaveBeenCalledWith(
      fakeDriver,
      12345,
      'A1',
      expect.objectContaining({ spotifyMatchConfidence: 'medium' }),
    );
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('skips a track when no candidate is within 5s of the track duration', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([
        { id: 'spotify-track-id-1', durationMs: 210_000 }, // 10s off → skip
      ]),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.getAudioFeaturesBatch).not.toHaveBeenCalled();
    expect(mockSetTrackAudioFeatures).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('skips a track when Spotify search returns no candidates', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockResolvedValue([]),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.getAudioFeaturesBatch).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('skips a track when Spotify returns null audio features for the matched id', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      getAudioFeaturesBatch: vi.fn().mockResolvedValue(new Map()), // empty — no features for id
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(mockSetTrackAudioFeatures).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('increments failed when searchTrack throws', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      searchTrack: vi.fn().mockRejectedValue(new Error('network error')),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.getAudioFeaturesBatch).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('increments failed for all batch tracks when getAudioFeaturesBatch throws', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);

    const client = makeClient({
      getAudioFeaturesBatch: vi.fn().mockRejectedValue(new Error('batch error')),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(mockSetTrackAudioFeatures).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('increments failed when setTrackAudioFeatures throws', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack]);
    mockSetTrackAudioFeatures.mockRejectedValue(new Error('neo4j write error'));

    const client = makeClient();

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

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
      getAudioFeaturesBatch: vi
        .fn()
        .mockResolvedValue(new Map([['close-id', { ...sampleAudioFeatures, id: 'close-id' }]])),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.getAudioFeaturesBatch).toHaveBeenCalledWith(['close-id']);
    expect(mockSetTrackAudioFeatures).toHaveBeenCalledWith(
      fakeDriver,
      12345,
      'A1',
      expect.objectContaining({ id: 'close-id', spotifyMatchConfidence: 'high' }),
    );
    expect(summary.enriched).toBe(1);
  });

  it('uses empty string artist name when artistName is null', async () => {
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([{ ...sampleTrack, artistName: null }]);

    const client = makeClient();

    await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.searchTrack).toHaveBeenCalledWith('', 'Test Song');
  });

  it('handles multiple tracks and batches correctly', async () => {
    const track2 = { ...sampleTrack, position: 'A2', releaseDiscogsId: 99999 };
    mockGetTracksForSpotifyEnrichment.mockResolvedValue([sampleTrack, track2]);

    const id1 = 'spotify-track-id-1';
    const id2 = 'spotify-track-id-2';

    const client = makeClient({
      searchTrack: vi
        .fn()
        .mockResolvedValueOnce([{ id: id1, durationMs: 200_000 }])
        .mockResolvedValueOnce([{ id: id2, durationMs: 200_000 }]),
      getAudioFeaturesBatch: vi.fn().mockResolvedValue(
        new Map([
          [id1, { ...sampleAudioFeatures, id: id1 }],
          [id2, { ...sampleAudioFeatures, id: id2 }],
        ]),
      ),
    });

    const summary = await enrichSpotifyAudioFeatures(client, fakeDriver);

    expect(client.getAudioFeaturesBatch).toHaveBeenCalledWith([id1, id2]);
    expect(mockSetTrackAudioFeatures).toHaveBeenCalledTimes(2);
    expect(summary.enriched).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });
});
