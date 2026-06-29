import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackRecordingLineage } from '../../../src/enrichment/track-recording-lineage.js';
import type { MbRecordingDerivation } from '../../../src/ingestion/musicbrainz-client.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetTracks = vi.hoisted(() => vi.fn());
const mockMergeLineage = vi.hoisted(() => vi.fn());
const mockSetFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-recording-lineage-repository.js', () => ({
  getTracksForRecordingLineageEnrichment: mockGetTracks,
  mergeRecordingLineage: mockMergeLineage,
  setRecordingLineageFetched: mockSetFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMbClient(
  getRels: (mbid: string) => Promise<MbRecordingDerivation[]> = async () => [],
) {
  return {
    getRecordingRelationsByMbid: vi.fn().mockImplementation(getRels),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const REMIX: MbRecordingDerivation = {
  recordingMbid: 'orig-1',
  title: 'Original Mix',
  type: 'remix',
  direction: 'forward',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('enrichTrackRecordingLineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracks.mockResolvedValue([]);
    mockMergeLineage.mockResolvedValue(undefined);
    mockSetFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no candidate recordings', async () => {
    const summary = await enrichTrackRecordingLineage(makeMbClient(), fakeDriver, silentLogger);

    expect(summary.recordingsProcessed).toBe(0);
    expect(summary.recordingsSkipped).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(summary.lineageEdges).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes one lineage edge group per recording and counts edges (tracks × derivations)', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    const client = makeMbClient(async () => [REMIX]);

    const summary = await enrichTrackRecordingLineage(client, fakeDriver, silentLogger);

    expect(client.getRecordingRelationsByMbid).toHaveBeenCalledWith('rec-1');
    expect(mockMergeLineage).toHaveBeenCalledWith(fakeDriver, 'rec-1', ['e1', 'e2'], [REMIX]);
    expect(summary.recordingsProcessed).toBe(1);
    // 2 tracks × 1 derivation
    expect(summary.lineageEdges).toBe(2);
  });

  it('dedupes derivations by (type, target), keeping the first seen', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => [
      REMIX,
      { ...REMIX, direction: 'backward' }, // same (type, target) → collapses
      { recordingMbid: 'inst-1', title: 'Instrumental', type: 'instrumental', direction: null },
    ]);

    await enrichTrackRecordingLineage(client, fakeDriver, silentLogger);

    expect(mockMergeLineage).toHaveBeenCalledWith(
      fakeDriver,
      'rec-1',
      ['e1'],
      [
        REMIX,
        { recordingMbid: 'inst-1', title: 'Instrumental', type: 'instrumental', direction: null },
      ],
    );
  });

  it('skips and stamps fetched when the recording has no lineage relations', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-x', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => []);

    const summary = await enrichTrackRecordingLineage(client, fakeDriver, silentLogger);

    expect(mockMergeLineage).not.toHaveBeenCalled();
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, ['e1']);
    expect(summary.recordingsSkipped).toBe(1);
    expect(summary.recordingsProcessed).toBe(0);
  });

  it('counts failed and does NOT stamp when the lookup throws', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => {
      throw new Error('MB API timeout');
    });

    const summary = await enrichTrackRecordingLineage(client, fakeDriver, silentLogger);

    expect(mockSetFetched).not.toHaveBeenCalled();
    expect(mockMergeLineage).not.toHaveBeenCalled();
    expect(summary.recordingsFailed).toBe(1);
  });

  it('does NOT warn when zero lineage is found — sparse is legitimate (#434)', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(async () => []);

    const summary = await enrichTrackRecordingLineage(client, fakeDriver, silentLogger);

    expect(summary.lineageEdges).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(silentLogger.warn).not.toHaveBeenCalled();
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('[track-recording-lineage]'),
    );
  });

  it('returns early with failed=1 when selecting candidates fails', async () => {
    mockGetTracks.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichTrackRecordingLineage(client, fakeDriver, silentLogger);

    expect(summary.recordingsFailed).toBe(1);
    expect(client.getRecordingRelationsByMbid).not.toHaveBeenCalled();
  });
});
