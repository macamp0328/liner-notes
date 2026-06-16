import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackRecordingPlaces } from '../../../src/enrichment/track-recording-places.js';
import type { MbRecordingPlace } from '../../../src/ingestion/musicbrainz-client.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetTracks = vi.hoisted(() => vi.fn());
const mockMergePlaces = vi.hoisted(() => vi.fn());
const mockSetFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-recording-places-repository.js', () => ({
  getTracksForRecordingPlacesEnrichment: mockGetTracks,
  mergeRecordingPlaces: mockMergePlaces,
  setRecordingPlacesFetched: mockSetFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMbClient(getPlaces: (mbid: string) => Promise<MbRecordingPlace[]> = async () => []) {
  return {
    getPlacesByRecordingMbid: vi.fn().mockImplementation(getPlaces),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const ABBEY_ROAD: MbRecordingPlace = {
  placeMbid: 'place-1',
  name: 'Abbey Road Studios',
  relation: 'recorded at',
  latitude: 51.53192,
  longitude: -0.17835,
  area: "St John's Wood",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('enrichTrackRecordingPlaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTracks.mockResolvedValue([]);
    mockMergePlaces.mockResolvedValue(undefined);
    mockSetFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no candidate recordings', async () => {
    const summary = await enrichTrackRecordingPlaces(makeMbClient(), fakeDriver, silentLogger);

    expect(summary.recordingsProcessed).toBe(0);
    expect(summary.recordingsSkipped).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    expect(summary.studioEdges).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes one studio edge group per recording and counts edges (tracks × studios)', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    const client = makeMbClient(async () => [ABBEY_ROAD]);

    const summary = await enrichTrackRecordingPlaces(client, fakeDriver, silentLogger);

    expect(client.getPlacesByRecordingMbid).toHaveBeenCalledWith('rec-1');
    expect(mockMergePlaces).toHaveBeenCalledWith(fakeDriver, 'rec-1', ['e1', 'e2'], [ABBEY_ROAD]);
    expect(summary.recordingsProcessed).toBe(1);
    // 2 tracks × 1 studio
    expect(summary.studioEdges).toBe(2);
  });

  it('dedupes multiple relations to the same studio name, keeping the first relation', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => [
      ABBEY_ROAD,
      { ...ABBEY_ROAD, relation: 'mixed at' }, // same name → collapses to one Studio edge
      {
        placeMbid: 'place-2',
        name: 'Olympic Studios',
        relation: 'recorded at',
        latitude: null,
        longitude: null,
        area: null,
      },
    ]);

    await enrichTrackRecordingPlaces(client, fakeDriver, silentLogger);

    expect(mockMergePlaces).toHaveBeenCalledWith(
      fakeDriver,
      'rec-1',
      ['e1'],
      [
        ABBEY_ROAD,
        {
          placeMbid: 'place-2',
          name: 'Olympic Studios',
          relation: 'recorded at',
          latitude: null,
          longitude: null,
          area: null,
        },
      ],
    );
  });

  it('skips and stamps fetched when the recording has no place relations', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-x', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => []);

    const summary = await enrichTrackRecordingPlaces(client, fakeDriver, silentLogger);

    expect(mockMergePlaces).not.toHaveBeenCalled();
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, ['e1']);
    expect(summary.recordingsSkipped).toBe(1);
    expect(summary.recordingsProcessed).toBe(0);
  });

  it('counts failed and does NOT stamp when the lookup throws', async () => {
    mockGetTracks.mockResolvedValue([{ recordingMbid: 'rec-1', trackElementIds: ['e1'] }]);
    const client = makeMbClient(async () => {
      throw new Error('MB API timeout');
    });

    const summary = await enrichTrackRecordingPlaces(client, fakeDriver, silentLogger);

    expect(mockSetFetched).not.toHaveBeenCalled();
    expect(mockMergePlaces).not.toHaveBeenCalled();
    expect(summary.recordingsFailed).toBe(1);
  });

  it('does NOT warn when zero studios are found — sparse is legitimate (#339)', async () => {
    mockGetTracks.mockResolvedValue([
      { recordingMbid: 'rec-1', trackElementIds: ['e1'] },
      { recordingMbid: 'rec-2', trackElementIds: ['e2'] },
    ]);
    const client = makeMbClient(async () => []); // no place relations for any recording

    const summary = await enrichTrackRecordingPlaces(client, fakeDriver, silentLogger);

    expect(summary.studioEdges).toBe(0);
    expect(summary.recordingsFailed).toBe(0);
    // Crucially: a sparse zero must never cry wolf. Only an info yield line, never a warn.
    expect(silentLogger.warn).not.toHaveBeenCalled();
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('[track-recording-places]'),
    );
  });

  it('returns early with failed=1 when selecting candidates fails', async () => {
    mockGetTracks.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichTrackRecordingPlaces(client, fakeDriver, silentLogger);

    expect(summary.recordingsFailed).toBe(1);
    expect(client.getPlacesByRecordingMbid).not.toHaveBeenCalled();
  });
});
