import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackAcousticBrainz } from '../../../src/enrichment/track-acousticbrainz.js';
import type { AcousticBrainzFeatures } from '../../../src/ingestion/acousticbrainz-client.js';
import type { AcousticBrainzClient } from '../../../src/ingestion/acousticbrainz-client.js';
import { MAX_RECORDING_IDS_PER_CALL } from '../../../src/ingestion/acousticbrainz-client.js';

// ---------------------------------------------------------------------------
// Hoisted repository mocks
// ---------------------------------------------------------------------------

const mockGetTracks = vi.hoisted(() => vi.fn());
const mockSetFeatures = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-acousticbrainz-repository.js', () => ({
  getTracksForAcousticBrainzEnrichment: mockGetTracks,
  setTrackAcousticBrainzFeatures: mockSetFeatures,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeDriver = {} as Driver;

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FULL_FEATURES: AcousticBrainzFeatures = {
  tempo: 130.5,
  musicalKey: 'C',
  musicalScale: 'minor',
  loudnessDb: 0.8,
  dynamicComplexity: 5.2,
  danceabilityEstimate: 0.75,
  voiceInstrumental: 'voice',
};

/**
 * Build a mock AcousticBrainzClient with an injectable getFeatures implementation.
 * Returns the mock client and a direct reference to the spy for call assertions.
 */
function makeAbClient(
  getFeaturesImpl: (mbids: string[]) => Promise<Map<string, AcousticBrainzFeatures>> = async () =>
    new Map(),
) {
  const getFeaturesSpy = vi.fn().mockImplementation(getFeaturesImpl);
  const client = { getFeatures: getFeaturesSpy } as unknown as AcousticBrainzClient;
  return { client, getFeaturesSpy };
}

function makeTrack(elementId: string, recordingMbid: string) {
  return { elementId, recordingMbid };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichTrackAcousticBrainz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetFeatures.mockResolvedValue(undefined);
  });

  it('returns zero counts immediately when no unenriched tracks exist', async () => {
    mockGetTracks.mockResolvedValue([]);
    const { client, getFeaturesSpy } = makeAbClient();

    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    expect(getFeaturesSpy).not.toHaveBeenCalled();
  });

  it('counts a track as processed when features are present', async () => {
    const mbid = 'aaaaaaaa-0000-0000-0000-000000000001';
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid)]);

    const { client } = makeAbClient(async () => new Map([[mbid, FULL_FEATURES]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(1);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    expect(mockSetFeatures).toHaveBeenCalledOnce();
    const [[, results]] = mockSetFeatures.mock.calls as [[Driver, Array<{ elementId: string }>]];
    expect(results[0]?.elementId).toBe('e1');
    expect(results[0]).toMatchObject({ tempo: 130.5, musicalKey: 'C' });
  });

  it('counts a track as skipped when MBID is absent from the AcousticBrainz response', async () => {
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'missing-mbid')]);

    const { client } = makeAbClient(async () => new Map());
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(1);
    expect(mockSetFeatures).toHaveBeenCalledOnce();
    const [[, results]] = mockSetFeatures.mock.calls as [
      [Driver, Array<{ elementId: string; tempo: unknown }>],
    ];
    expect(results[0]?.elementId).toBe('e1');
    expect(results[0]?.tempo).toBeNull();
  });

  it('counts a track as skipped when all feature fields are null', async () => {
    const mbid = 'aaaaaaaa-0000-0000-0000-000000000002';
    const emptyFeatures: AcousticBrainzFeatures = {
      tempo: null,
      musicalKey: null,
      musicalScale: null,
      loudnessDb: null,
      dynamicComplexity: null,
      danceabilityEstimate: null,
      voiceInstrumental: null,
    };
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid)]);

    const { client } = makeAbClient(async () => new Map([[mbid, emptyFeatures]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(1);
  });

  it('deduplicates recording MBIDs across multiple tracks', async () => {
    const mbid = 'shared-0000-0000-0000-000000000003';
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid), makeTrack('e2', mbid)]);

    const { client, getFeaturesSpy } = makeAbClient(async () => new Map([[mbid, FULL_FEATURES]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(getFeaturesSpy).toHaveBeenCalledOnce();
    expect(getFeaturesSpy).toHaveBeenCalledWith([mbid]);
    expect(summary.tracksProcessed).toBe(2);
    expect(mockSetFeatures).toHaveBeenCalledOnce();
    const [[, results]] = mockSetFeatures.mock.calls as [[Driver, Array<{ elementId: string }>]];
    const written = results.map((r) => r.elementId).sort();
    expect(written).toEqual(['e1', 'e2'].sort());
  });

  it('splits into multiple batches when unique MBIDs exceed MAX_RECORDING_IDS_PER_CALL', async () => {
    const tracks = Array.from({ length: MAX_RECORDING_IDS_PER_CALL + 1 }, (_, i) =>
      makeTrack(`e${i}`, `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`),
    );
    mockGetTracks.mockResolvedValue(tracks);

    const { client, getFeaturesSpy } = makeAbClient(async () => new Map());
    await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(getFeaturesSpy).toHaveBeenCalledTimes(2);
    const firstBatchCall = getFeaturesSpy.mock.calls[0] as [string[]];
    const secondBatchCall = getFeaturesSpy.mock.calls[1] as [string[]];
    expect(firstBatchCall[0]).toHaveLength(MAX_RECORDING_IDS_PER_CALL);
    expect(secondBatchCall[0]).toHaveLength(1);
  });

  it('counts batch tracks as failed when getFeatures throws, and does not write them', async () => {
    const mbid = 'fail-mbid-0000-0000-0000-000000000004';
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid), makeTrack('e2', mbid)]);

    const { client } = makeAbClient(async () => {
      throw new Error('network error');
    });
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(2);
    expect(summary.tracksProcessed).toBe(0);
    expect(mockSetFeatures).not.toHaveBeenCalled();
  });

  it('counts batch tracks as failed when the write throws, and continues without crashing', async () => {
    const mbid = 'write-fail-0000-0000-0000-000000000005';
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid)]);
    mockSetFeatures.mockRejectedValue(new Error('Neo4j write error'));

    const { client } = makeAbClient(async () => new Map([[mbid, FULL_FEATURES]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
  });

  it('continues processing other batches after one batch fails', async () => {
    // Fill two batches: first batch (MAX MBIDs) fails, second batch (1 MBID) succeeds.
    const failingTracks = Array.from({ length: MAX_RECORDING_IDS_PER_CALL }, (_, i) =>
      makeTrack(`fail-e${i}`, `fail${String(i).padStart(4, '0')}-0000-0000-000000000008`),
    );
    const okMbid = 'okay-0000-0000-0000-000000000009';
    mockGetTracks.mockResolvedValue([...failingTracks, makeTrack('ok-e0', okMbid)]);

    let callCount = 0;
    const { client } = makeAbClient(async (mbids: string[]) => {
      callCount++;
      if (callCount === 1) throw new Error('first batch fails');
      return new Map([[mbids[0]!, FULL_FEATURES]]);
    });

    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(MAX_RECORDING_IDS_PER_CALL);
    expect(summary.tracksProcessed).toBe(1);
  });

  it('logs a progress message when batchIndex is a nonzero multiple of 10', async () => {
    // Need >10 batches: 11 * MAX_RECORDING_IDS_PER_CALL + 1 unique MBIDs.
    const tracks = Array.from({ length: MAX_RECORDING_IDS_PER_CALL * 11 }, (_, i) =>
      makeTrack(`e${i}`, `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`),
    );
    mockGetTracks.mockResolvedValue(tracks);

    const { client } = makeAbClient(async () => new Map());
    await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    // At batch index 10 the progress log should fire.
    expect(silentLogger.info).toHaveBeenCalledWith(expect.stringContaining('Progress:'));
  });

  it('returns early with tracksFailed: 1 when the DB fetch itself throws', async () => {
    mockGetTracks.mockRejectedValue(new Error('connection refused'));

    const { client, getFeaturesSpy } = makeAbClient();
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(getFeaturesSpy).not.toHaveBeenCalled();
  });
});
