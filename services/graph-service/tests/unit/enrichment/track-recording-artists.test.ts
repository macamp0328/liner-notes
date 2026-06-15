import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackRecordingArtists } from '../../../src/enrichment/track-recording-artists.js';
import type { MbRecordingArtist } from '../../../src/ingestion/musicbrainz-client.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetTracks = vi.hoisted(() => vi.fn());
const mockMergeCredits = vi.hoisted(() => vi.fn());
const mockSetFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-recording-artists-repository.js', () => ({
  getTracksForRecordingArtistsEnrichment: mockGetTracks,
  mergeRecordingArtistCredits: mockMergeCredits,
  setRecordingArtistsFetched: mockSetFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMbClient(getArtists: (mbid: string) => Promise<MbRecordingArtist[]> = async () => []) {
  return {
    getArtistsByRecordingMbid: vi.fn().mockImplementation(getArtists),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const GUITAR: MbRecordingArtist = {
  mbid: 'a-1',
  name: 'Glenn Frey',
  role: 'instrument',
  attributes: ['12 string guitar'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('enrichTrackRecordingArtists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracks.mockResolvedValue([]);
    mockMergeCredits.mockResolvedValue(undefined);
    mockSetFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no candidate recordings', async () => {
    const summary = await enrichTrackRecordingArtists(makeMbClient(), fakeDriver, silentLogger);

    expect(summary.recordingsProcessed).toBe(0);
    expect(summary.recordingsSkipped).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(summary.creditEdges).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes one credit per performer and counts edges (tracks × credits)', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    const client = makeMbClient(async () => [GUITAR]);

    const summary = await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(client.getArtistsByRecordingMbid).toHaveBeenCalledWith('rec-1');
    expect(mockMergeCredits).toHaveBeenCalledWith(
      fakeDriver,
      'rec-1',
      ['e1', 'e2'],
      [{ mbid: 'a-1', name: 'Glenn Frey', role: '12 string guitar' }],
    );
    expect(summary.recordingsProcessed).toBe(1);
    // 2 tracks × 1 credit
    expect(summary.creditEdges).toBe(2);
  });

  it('groups a performer’s multiple relations into one credit with a combined role', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => [
      { mbid: 'a-2', name: 'Don Henley', role: 'instrument', attributes: ['drums (drum set)'] },
      { mbid: 'a-2', name: 'Don Henley', role: 'vocal', attributes: ['lead vocals'] },
      // a bare performer relation contributes the relation type as its token
      { mbid: 'a-3', name: 'Joe Walsh', role: 'performer', attributes: [] },
    ]);

    await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(mockMergeCredits).toHaveBeenCalledWith(
      fakeDriver,
      'rec-1',
      ['e1'],
      [
        { mbid: 'a-2', name: 'Don Henley', role: 'drums (drum set), lead vocals' },
        { mbid: 'a-3', name: 'Joe Walsh', role: 'performer' },
      ],
    );
  });

  it('skips and stamps fetched when the recording has no performance relations', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-x', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => []);

    const summary = await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(mockMergeCredits).not.toHaveBeenCalled();
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, ['e1']);
    expect(summary.recordingsSkipped).toBe(1);
    expect(summary.recordingsProcessed).toBe(0);
  });

  it('counts failed and does NOT stamp when the lookup throws', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => {
      throw new Error('MB API timeout');
    });

    const summary = await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(mockSetFetched).not.toHaveBeenCalled();
    expect(mockMergeCredits).not.toHaveBeenCalled();
    expect(summary.recordingsFailed).toBe(1);
  });

  it('continues processing remaining recordings after a per-recording failure', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(
      vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce([GUITAR]),
    );

    const summary = await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(summary.recordingsFailed).toBe(1);
    expect(summary.recordingsProcessed).toBe(1);
    expect(mockMergeCredits).toHaveBeenCalledOnce();
    expect(mockMergeCredits).toHaveBeenCalledWith(
      fakeDriver,
      'rec-2',
      ['e2'],
      [{ mbid: 'a-1', name: 'Glenn Frey', role: '12 string guitar' }],
    );
  });

  it('warns when recordings were found but no edges were written (silent no-op)', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(async () => []); // no performance relations for any recording

    const summary = await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(summary.creditEdges).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No-op'));
  });

  it('does NOT warn when edges were written', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => [GUITAR]);

    await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(silentLogger.warn).not.toHaveBeenCalled();
  });

  it('returns early with failed=1 when selecting candidates fails', async () => {
    mockGetTracks.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichTrackRecordingArtists(client, fakeDriver, silentLogger);

    expect(summary.recordingsFailed).toBe(1);
    expect(client.getArtistsByRecordingMbid).not.toHaveBeenCalled();
  });
});
