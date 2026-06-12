import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackDeezer } from '../../../src/enrichment/track-deezer.js';
import type { DeezerClient } from '../../../src/ingestion/deezer-client.js';

// ---------------------------------------------------------------------------
// Hoisted repository mocks
// ---------------------------------------------------------------------------

const mockGetTracks = vi.hoisted(() => vi.fn());
const mockSetData = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-deezer-repository.js', () => ({
  getTracksForDeezerEnrichment: mockGetTracks,
  setTrackDeezerData: mockSetData,
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

function makeDeezerClient(
  getTrackImpl: (
    isrc: string,
  ) => Promise<{ bpm: number | null; gain: number | null } | null> = async () => null,
): DeezerClient {
  return { getTrackByIsrc: vi.fn().mockImplementation(getTrackImpl) } as unknown as DeezerClient;
}

function makeTrack(elementId: string, isrc: string) {
  return { elementId, isrc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichTrackDeezer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetData.mockResolvedValue(undefined);
  });

  it('returns zero counts immediately when no unenriched tracks exist', async () => {
    mockGetTracks.mockResolvedValue([]);
    const client = makeDeezerClient();

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    expect(client.getTrackByIsrc).not.toHaveBeenCalled();
  });

  it('counts a track as processed when bpm and gain are returned', async () => {
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'USUM71703861')]);
    const client = makeDeezerClient(async () => ({ bpm: 128.5, gain: -8.3 }));

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(1);
    expect(summary.tracksSkipped).toBe(0);
    expect(mockSetData).toHaveBeenCalledOnce();
    const [[, results]] = mockSetData.mock.calls as [
      [Driver, Array<{ elementId: string; deezerBpm: number | null }>],
    ];
    expect(results[0]?.elementId).toBe('e1');
    expect(results[0]?.deezerBpm).toBe(128.5);
  });

  it('counts a track as skipped when Deezer returns null (not in catalog)', async () => {
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'MISSING00001')]);
    const client = makeDeezerClient(async () => null);

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(1);
    expect(mockSetData).toHaveBeenCalledOnce();
    const [[, results]] = mockSetData.mock.calls as [[Driver, Array<{ deezerBpm: unknown }>]];
    expect(results[0]?.deezerBpm).toBeNull();
  });

  it('deduplicates ISRCs: one API call fans out to every track sharing that ISRC', async () => {
    const isrc = 'SHARED00001';
    mockGetTracks.mockResolvedValue([makeTrack('e1', isrc), makeTrack('e2', isrc)]);
    const getTrackSpy = vi.fn().mockResolvedValue({ bpm: 120.0, gain: -5.0 });
    const client = { getTrackByIsrc: getTrackSpy } as unknown as DeezerClient;
    const onProgress = vi.fn();

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger, onProgress);

    expect(getTrackSpy).toHaveBeenCalledOnce();
    expect(getTrackSpy).toHaveBeenCalledWith(isrc);
    expect(summary.tracksProcessed).toBe(2);

    const [[, results]] = mockSetData.mock.calls as [[Driver, Array<{ elementId: string }>]];
    expect(results.map((r) => r.elementId).sort()).toEqual(['e1', 'e2'].sort());

    // Progress is reported in unique-ISRC units (1), not track count (2).
    expect(onProgress).toHaveBeenCalledWith(0, 1);
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
  });

  it('counts a fetch error against all tracks sharing that ISRC and does not write them', async () => {
    const isrc = 'FAIL00000001';
    mockGetTracks.mockResolvedValue([makeTrack('e1', isrc), makeTrack('e2', isrc)]);
    const client = makeDeezerClient(async () => {
      throw new Error('network error');
    });

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(2);
    expect(summary.tracksProcessed).toBe(0);
    expect(mockSetData).not.toHaveBeenCalled();
  });

  it('counts write-batch failure against all tracks in that batch without crashing', async () => {
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'WFAIL000001')]);
    mockSetData.mockRejectedValue(new Error('Neo4j write error'));
    const client = makeDeezerClient(async () => ({ bpm: 100.0, gain: -3.0 }));

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
  });

  it('flushes incrementally when pending results reach WRITE_BATCH_SIZE (50)', async () => {
    // 51 unique ISRCs → first flush at 50, second flush at 51
    const tracks = Array.from({ length: 51 }, (_, i) =>
      makeTrack(`e${i}`, `ISRC${String(i).padStart(7, '0')}`),
    );
    mockGetTracks.mockResolvedValue(tracks);
    const client = makeDeezerClient(async () => ({ bpm: 120.0, gain: -4.0 }));

    await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(mockSetData).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockSetData.mock.calls as [
      [Driver, unknown[]],
      [Driver, unknown[]],
    ];
    expect(firstCall[1]).toHaveLength(50);
    expect(secondCall[1]).toHaveLength(1);
  });

  it('only increments counts after a successful flush', async () => {
    // First flush (50 tracks) succeeds; second flush (1 track) fails.
    const tracks = Array.from({ length: 51 }, (_, i) =>
      makeTrack(`e${i}`, `ISRC${String(i).padStart(7, '0')}`),
    );
    mockGetTracks.mockResolvedValue(tracks);
    mockSetData.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write fails'));
    const client = makeDeezerClient(async () => ({ bpm: 120.0, gain: -4.0 }));

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(50);
    expect(summary.tracksFailed).toBe(1);
  });

  it('returns early with tracksFailed: 1 when the DB fetch itself throws', async () => {
    mockGetTracks.mockRejectedValue(new Error('connection refused'));
    const client = makeDeezerClient();

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(client.getTrackByIsrc).not.toHaveBeenCalled();
  });

  it('logs a progress message and reports onProgress every 50 unique ISRCs processed', async () => {
    const tracks = Array.from({ length: 51 }, (_, i) =>
      makeTrack(`e${i}`, `ISRC${String(i).padStart(7, '0')}`),
    );
    mockGetTracks.mockResolvedValue(tracks);
    const client = makeDeezerClient(async () => null);
    const onProgress = vi.fn();

    await enrichTrackDeezer(client, fakeDriver, silentLogger, onProgress);

    expect(silentLogger.info).toHaveBeenCalledWith(expect.stringContaining('Progress:'));
    expect(onProgress).toHaveBeenCalledWith(50, 51); // mid-loop report at the 50-ISRC cadence
    expect(onProgress).toHaveBeenLastCalledWith(51, 51);
  });

  // Cooperative shutdown abort (#291)
  it('processes nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'AAA0000001')]);
    const client = makeDeezerClient(async () => ({ bpm: 120, gain: -4 }));

    const summary = await enrichTrackDeezer(
      client,
      fakeDriver,
      silentLogger,
      undefined,
      controller.signal,
    );

    expect(client.getTrackByIsrc).not.toHaveBeenCalled();
    expect(summary.tracksProcessed).toBe(0);
    expect(mockSetData).not.toHaveBeenCalled();
  });

  it('checkpoint-exits between ISRCs on shutdown, flushing the buffered batch', async () => {
    const controller = new AbortController();
    mockGetTracks.mockResolvedValue([makeTrack('e1', 'AAA0000001'), makeTrack('e2', 'BBB0000002')]);
    const getTrackSpy = vi.fn().mockImplementation(async () => {
      controller.abort(); // signal arrives during the first fetch
      return { bpm: 120, gain: -4 };
    });
    const client = { getTrackByIsrc: getTrackSpy } as unknown as DeezerClient;
    const onProgress = vi.fn();

    const summary = await enrichTrackDeezer(
      client,
      fakeDriver,
      silentLogger,
      onProgress,
      controller.signal,
    );

    expect(getTrackSpy).toHaveBeenCalledTimes(1); // 2nd ISRC skipped by the abort
    expect(summary.tracksProcessed).toBe(1);
    expect(mockSetData).toHaveBeenCalledOnce(); // buffered result flushed post-loop
    expect(onProgress).toHaveBeenLastCalledWith(1, 2); // honest partial progress, not 2/2 (#291)
  });
});
