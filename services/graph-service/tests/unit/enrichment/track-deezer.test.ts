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
  debug: vi.fn(),
};

function makeDeezerClient(
  getTrack: (isrc: string) => Promise<{ bpm: number | null; gain: number | null } | null>,
): DeezerClient {
  return { getTrackByIsrc: vi.fn().mockImplementation(getTrack) } as unknown as DeezerClient;
}

// ---------------------------------------------------------------------------
// enrichTrackDeezer
// ---------------------------------------------------------------------------
describe('enrichTrackDeezer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracks.mockResolvedValue([]);
    mockSetData.mockResolvedValue(undefined);
  });

  it('returns zero counts and makes no API calls when there are no tracks', async () => {
    const client = makeDeezerClient(async () => null);
    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(0);
    expect(summary.tracksEnriched).toBe(0);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    expect(client.getTrackByIsrc).not.toHaveBeenCalled();
    expect(mockSetData).not.toHaveBeenCalled();
  });

  it('enriches tracks with bpm and gain and marks them written', async () => {
    mockGetTracks.mockResolvedValue([
      { elementId: 'e1', isrc: 'USUM71900001' },
      { elementId: 'e2', isrc: 'GBUM71900002' },
    ]);
    const client = makeDeezerClient(async (isrc) => {
      if (isrc === 'USUM71900001') return { bpm: 128.5, gain: -6.2 };
      return { bpm: 100.0, gain: -4.0 };
    });

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(2);
    expect(summary.tracksEnriched).toBe(2);
    expect(summary.tracksSkipped).toBe(0);
    expect(summary.tracksFailed).toBe(0);
    expect(mockSetData).toHaveBeenCalledWith(fakeDriver, [
      { elementId: 'e1', deezerBpm: 128.5, deezerGain: -6.2 },
      { elementId: 'e2', deezerBpm: 100.0, deezerGain: -4.0 },
    ]);
  });

  it('counts as skipped when Deezer returns null (ISRC not found)', async () => {
    mockGetTracks.mockResolvedValue([{ elementId: 'e1', isrc: 'UNKNOWN' }]);
    const client = makeDeezerClient(async () => null);

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksProcessed).toBe(1);
    expect(summary.tracksEnriched).toBe(0);
    expect(summary.tracksSkipped).toBe(1);
    expect(mockSetData).toHaveBeenCalledWith(fakeDriver, [
      { elementId: 'e1', deezerBpm: null, deezerGain: null },
    ]);
  });

  it('counts as skipped when Deezer returns data with both bpm and gain null', async () => {
    mockGetTracks.mockResolvedValue([{ elementId: 'e1', isrc: 'USUM71900001' }]);
    const client = makeDeezerClient(async () => ({ bpm: null, gain: null }));

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksSkipped).toBe(1);
    expect(summary.tracksEnriched).toBe(0);
  });

  it('counts a failed track and does NOT write it to the repository', async () => {
    mockGetTracks.mockResolvedValue([{ elementId: 'e1', isrc: 'USUM71900001' }]);
    const client = makeDeezerClient(async () => {
      throw new Error('API timeout');
    });

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
    expect(mockSetData).not.toHaveBeenCalled();
  });

  it('continues processing after a per-track failure', async () => {
    mockGetTracks.mockResolvedValue([
      { elementId: 'e1', isrc: 'BAD' },
      { elementId: 'e2', isrc: 'GOOD' },
    ]);
    const client = makeDeezerClient(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ bpm: 90.0, gain: -2.0 }),
    );

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksEnriched).toBe(1);
    expect(mockSetData).toHaveBeenCalledWith(fakeDriver, [
      { elementId: 'e2', deezerBpm: 90.0, deezerGain: -2.0 },
    ]);
  });

  it('logs an error and does not throw when the write to the repository fails', async () => {
    mockGetTracks.mockResolvedValue([{ elementId: 'e1', isrc: 'USUM71900001' }]);
    mockSetData.mockRejectedValue(new Error('write timeout'));
    const client = makeDeezerClient(async () => ({ bpm: 128.5, gain: -6.2 }));

    await expect(enrichTrackDeezer(client, fakeDriver, silentLogger)).resolves.toMatchObject({
      tracksEnriched: 1,
      tracksFailed: 0,
    });
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write enrichment results'),
    );
  });

  it('returns early with tracksFailed=1 when fetching tracks from the repository fails', async () => {
    mockGetTracks.mockRejectedValue(new Error('DB connection lost'));
    const client = makeDeezerClient(async () => null);

    const summary = await enrichTrackDeezer(client, fakeDriver, silentLogger);

    expect(summary.tracksFailed).toBe(1);
    expect(summary.tracksProcessed).toBe(0);
    expect(client.getTrackByIsrc).not.toHaveBeenCalled();
    expect(mockSetData).not.toHaveBeenCalled();
  });
});
