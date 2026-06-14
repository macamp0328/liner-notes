import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackWorks } from '../../../src/enrichment/track-works.js';
import type { MbWork, MbWorkWriter } from '../../../src/ingestion/musicbrainz-client.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetTracks = vi.hoisted(() => vi.fn());
const mockMergeWorks = vi.hoisted(() => vi.fn());
const mockSetFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-works-repository.js', () => ({
  getTracksForWorksEnrichment: mockGetTracks,
  mergeTrackWorks: mockMergeWorks,
  setTrackWorksFetched: mockSetFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMbClient(
  getWorks: (mbid: string) => Promise<MbWork[]> = async () => [],
  getWriters: (mbid: string) => Promise<MbWorkWriter[]> = async () => [],
) {
  return {
    getWorksByRecordingMbid: vi.fn().mockImplementation(getWorks),
    getWritersByWorkMbid: vi.fn().mockImplementation(getWriters),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const WORK: MbWork = { mbid: 'work-1', title: 'Who Do You Love?', type: 'Song' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('enrichTrackWorks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracks.mockResolvedValue([]);
    mockMergeWorks.mockResolvedValue(undefined);
    mockSetFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no candidate recordings', async () => {
    const summary = await enrichTrackWorks(makeMbClient(), fakeDriver, silentLogger);

    expect(summary.recordingsProcessed).toBe(0);
    expect(summary.recordingsSkipped).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(summary.worksWritten).toBe(0);
    expect(summary.recordingOfEdges).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('links every candidate track to the resolved work and counts edges', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    const client = makeMbClient(async () => [WORK]);

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(client.getWorksByRecordingMbid).toHaveBeenCalledWith('rec-1');
    expect(mockMergeWorks).toHaveBeenCalledWith(
      fakeDriver,
      ['e1', 'e2'],
      [{ ...WORK, writers: [] }],
    );
    expect(summary.recordingsProcessed).toBe(1);
    expect(summary.worksWritten).toBe(1);
    // 2 tracks × 1 work
    expect(summary.recordingOfEdges).toBe(2);
  });

  it('captures writers on the work', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const writers: MbWorkWriter[] = [{ mbid: 'a-1', name: 'Bo Diddley', role: 'composer' }];
    const client = makeMbClient(
      async () => [WORK],
      async () => writers,
    );

    await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(mockMergeWorks).toHaveBeenCalledWith(fakeDriver, ['e1'], [{ ...WORK, writers }]);
  });

  it('skips and stamps fetched when the recording has no work', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-x', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => []);

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(mockMergeWorks).not.toHaveBeenCalled();
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, ['e1']);
    expect(summary.recordingsSkipped).toBe(1);
    expect(summary.recordingsProcessed).toBe(0);
  });

  it('counts failed and does NOT stamp when the lookup throws', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => {
      throw new Error('MB API timeout');
    });

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(mockSetFetched).not.toHaveBeenCalled();
    expect(mockMergeWorks).not.toHaveBeenCalled();
    expect(summary.recordingsFailed).toBe(1);
  });

  it('memoizes writer lookups for a work shared across recordings (the cover case)', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(
      async () => [WORK], // both recordings perform the same work
      async () => [{ mbid: 'a-1', name: 'Bo Diddley', role: 'composer' }],
    );

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(client.getWorksByRecordingMbid).toHaveBeenCalledTimes(2);
    // writers for work-1 fetched once, reused for the second recording
    expect(client.getWritersByWorkMbid).toHaveBeenCalledTimes(1);
    expect(summary.recordingsProcessed).toBe(2);
  });

  it('continues processing remaining recordings after a per-recording failure', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(
      vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce([WORK]),
    );

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(summary.recordingsFailed).toBe(1);
    expect(summary.recordingsProcessed).toBe(1);
    expect(mockMergeWorks).toHaveBeenCalledOnce();
    expect(mockMergeWorks).toHaveBeenCalledWith(fakeDriver, ['e2'], [{ ...WORK, writers: [] }]);
  });

  it('warns when recordings were found but no edges were written (silent no-op)', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(async () => []); // no works for any recording

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(summary.recordingOfEdges).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No-op'));
  });

  it('does NOT warn when edges were written', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => [WORK]);

    await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(silentLogger.warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when recordings failed (already surfaced as errors)', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => {
      throw new Error('boom');
    });

    await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(silentLogger.warn).not.toHaveBeenCalled();
  });

  it('returns early with failed=1 when selecting candidates fails', async () => {
    mockGetTracks.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichTrackWorks(client, fakeDriver, silentLogger);

    expect(summary.recordingsFailed).toBe(1);
    expect(client.getWorksByRecordingMbid).not.toHaveBeenCalled();
  });
});
