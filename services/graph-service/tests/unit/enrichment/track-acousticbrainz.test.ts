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
const mockMarkExhausted = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-acousticbrainz-repository.js', () => ({
  getTracksForAcousticBrainzEnrichment: mockGetTracks,
  setTrackAcousticBrainzFeatures: mockSetFeatures,
  markTrackAcousticBrainzExhausted: mockMarkExhausted,
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
    mockMarkExhausted.mockResolvedValue(undefined);
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
    expect(summary.tracksExhausted).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    expect(mockSetFeatures).toHaveBeenCalledOnce();
    expect(mockMarkExhausted).toHaveBeenCalledWith(fakeDriver, []);
    const [[, results]] = mockSetFeatures.mock.calls as [[Driver, Array<{ elementId: string }>]];
    expect(results[0]?.elementId).toBe('e1');
    expect(results[0]).toMatchObject({ tempo: 130.5, musicalKey: 'C' });
  });

  it('counts a track as exhausted (terminal) when MBID is absent from the AcousticBrainz response', async () => {
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'missing-mbid')]);

    const { client } = makeAbClient(async () => new Map());
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    // Frozen source: a recording absent from a successful response is permanently exhausted (#384).
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksExhausted).toBe(1);
    expect(mockMarkExhausted).toHaveBeenCalledWith(fakeDriver, ['e1']);
    // No features to write for an absent track — setFeatures is called with an empty batch.
    expect(mockSetFeatures).toHaveBeenCalledWith(fakeDriver, []);
  });

  it('counts a track as exhausted when present but all feature fields are null', async () => {
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

    // Present-but-all-null is just as permanent as absent on a frozen source → terminal, not throttled.
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksExhausted).toBe(1);
    expect(mockMarkExhausted).toHaveBeenCalledWith(fakeDriver, ['e1']);
  });

  it('splits a mixed batch into processed (features) and exhausted (no features)', async () => {
    const matched = 'aaaaaaaa-0000-0000-0000-000000000010';
    const absent = 'aaaaaaaa-0000-0000-0000-000000000011';
    mockGetTracks.mockResolvedValue([makeTrack('e1', matched), makeTrack('e2', absent)]);

    const { client } = makeAbClient(async () => new Map([[matched, FULL_FEATURES]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(1);
    expect(summary.tracksExhausted).toBe(1);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    const [[, written]] = mockSetFeatures.mock.calls as [[Driver, Array<{ elementId: string }>]];
    expect(written.map((r) => r.elementId)).toEqual(['e1']);
    expect(mockMarkExhausted).toHaveBeenCalledWith(fakeDriver, ['e2']);
  });

  it('deduplicates recording MBIDs across multiple tracks', async () => {
    const mbid = 'shared-0000-0000-0000-000000000003';
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid), makeTrack('e2', mbid)]);

    const { client, getFeaturesSpy } = makeAbClient(async () => new Map([[mbid, FULL_FEATURES]]));
    const onProgress = vi.fn();
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger, onProgress);

    expect(getFeaturesSpy).toHaveBeenCalledOnce();
    expect(getFeaturesSpy).toHaveBeenCalledWith([mbid]);
    expect(summary.tracksProcessed).toBe(2);
    expect(mockSetFeatures).toHaveBeenCalledOnce();
    const [[, results]] = mockSetFeatures.mock.calls as [[Driver, Array<{ elementId: string }>]];
    const written = results.map((r) => r.elementId).sort();
    expect(written).toEqual(['e1', 'e2'].sort());

    // Progress is reported in unique-recording (MBID) units (1), not track count (2).
    expect(onProgress).toHaveBeenCalledWith(0, 1);
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
  });

  it('splits into multiple batches when unique MBIDs exceed MAX_RECORDING_IDS_PER_CALL', async () => {
    const tracks = Array.from({ length: MAX_RECORDING_IDS_PER_CALL + 1 }, (_, i) =>
      makeTrack(`e${i}`, `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`),
    );
    mockGetTracks.mockResolvedValue(tracks);

    const { client, getFeaturesSpy } = makeAbClient(async () => new Map());
    const onProgress = vi.fn();
    await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger, onProgress);

    expect(getFeaturesSpy).toHaveBeenCalledTimes(2);
    const firstBatchCall = getFeaturesSpy.mock.calls[0] as [string[]];
    const secondBatchCall = getFeaturesSpy.mock.calls[1] as [string[]];
    expect(firstBatchCall[0]).toHaveLength(MAX_RECORDING_IDS_PER_CALL);
    expect(secondBatchCall[0]).toHaveLength(1);

    // Per-batch progress advances in MBID units and is clamped to the total.
    const total = MAX_RECORDING_IDS_PER_CALL + 1;
    expect(onProgress).toHaveBeenCalledWith(MAX_RECORDING_IDS_PER_CALL, total); // after batch 0
    expect(onProgress).toHaveBeenLastCalledWith(total, total); // after batch 1 + final
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
    // A transient failure must NEVER write the terminal marker (the 404-vs-5xx distinction, #384).
    expect(summary.tracksExhausted).toBe(0);
    expect(mockSetFeatures).not.toHaveBeenCalled();
    expect(mockMarkExhausted).not.toHaveBeenCalled();
  });

  it('counts batch tracks as failed when the feature write throws, and continues without crashing', async () => {
    const mbid = 'write-fail-0000-0000-0000-000000000005';
    mockGetTracks.mockResolvedValue([makeTrack('e1', mbid)]);
    mockSetFeatures.mockRejectedValue(new Error('Neo4j write error'));

    const { client } = makeAbClient(async () => new Map([[mbid, FULL_FEATURES]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksExhausted).toBe(0);
  });

  it('counts the whole batch failed (not partially processed) when the exhausted-marker write throws', async () => {
    const matched = 'aaaaaaaa-0000-0000-0000-000000000020';
    const absent = 'aaaaaaaa-0000-0000-0000-000000000021';
    mockGetTracks.mockResolvedValue([makeTrack('e1', matched), makeTrack('e2', absent)]);
    // The feature write succeeds; the terminal-marker write (second await) throws.
    mockMarkExhausted.mockRejectedValue(new Error('Neo4j write error'));

    const { client } = makeAbClient(async () => new Map([[matched, FULL_FEATURES]]));
    const summary = await enrichTrackAcousticBrainz(client, fakeDriver, silentLogger);

    // Counters increment only after BOTH writes succeed — the processed track is not double-counted.
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksExhausted).toBe(0);
    expect(summary.tracksFailed).toBe(2);
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

  // Cooperative shutdown abort (#291)
  it('processes nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'mbid-0001')]);
    const { client, getFeaturesSpy } = makeAbClient(
      async (mbids) => new Map(mbids.map((m) => [m, FULL_FEATURES])),
    );

    const summary = await enrichTrackAcousticBrainz(
      client,
      fakeDriver,
      silentLogger,
      undefined,
      controller.signal,
    );

    expect(getFeaturesSpy).not.toHaveBeenCalled();
    expect(summary.tracksProcessed).toBe(0);
    expect(mockSetFeatures).not.toHaveBeenCalled();
  });

  it('checkpoint-exits between batches on shutdown, keeping the first written batch', async () => {
    const controller = new AbortController();
    const tracks = Array.from({ length: MAX_RECORDING_IDS_PER_CALL * 2 }, (_, i) =>
      makeTrack(`e${i}`, `${String(i).padStart(8, '0')}-0000-0000-0000-00000000000a`),
    );
    mockGetTracks.mockResolvedValue(tracks);
    const getFeaturesSpy = vi.fn().mockImplementation(async (mbids: string[]) => {
      controller.abort(); // signal arrives during the first batch
      return new Map(mbids.map((m) => [m, FULL_FEATURES]));
    });
    const client = { getFeatures: getFeaturesSpy } as unknown as AcousticBrainzClient;
    const onProgress = vi.fn();

    const summary = await enrichTrackAcousticBrainz(
      client,
      fakeDriver,
      silentLogger,
      onProgress,
      controller.signal,
    );

    expect(getFeaturesSpy).toHaveBeenCalledTimes(1); // 2nd batch skipped by the abort
    expect(summary.tracksProcessed).toBe(MAX_RECORDING_IDS_PER_CALL); // first batch persisted
    expect(mockSetFeatures).toHaveBeenCalledOnce();
    // Honest partial progress: one batch's worth of recordings, not total (#291).
    expect(onProgress).toHaveBeenLastCalledWith(
      MAX_RECORDING_IDS_PER_CALL,
      MAX_RECORDING_IDS_PER_CALL * 2,
    );
  });
});
