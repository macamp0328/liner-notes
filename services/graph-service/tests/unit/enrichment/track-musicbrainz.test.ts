import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import {
  normalizeForMatch,
  titleSimilarity,
  isValidMatch,
  alignTracklist,
  enrichTrackMusicBrainz,
} from '../../../src/enrichment/track-musicbrainz.js';
import type {
  MbRecordingTrack,
  MbRecordingMatch,
} from '../../../src/ingestion/musicbrainz-client.js';
import type { TrackForMusicBrainz } from '../../../src/db/track-musicbrainz-repository.js';

// ---------------------------------------------------------------------------
// Hoisted repository mocks
// ---------------------------------------------------------------------------
const mockGetReleases = vi.hoisted(() => vi.fn());
const mockSetIds = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-musicbrainz-repository.js', () => ({
  getTracksForMusicBrainzEnrichment: mockGetReleases,
  setTrackMusicBrainzIds: mockSetIds,
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

function makeMbClient(overrides: {
  getReleaseMbid?: (id: number) => Promise<string | null>;
  getRecordings?: (mbid: string) => Promise<MbRecordingTrack[]>;
  search?: (title: string, artist: string, dur: number | null) => Promise<MbRecordingMatch | null>;
}) {
  return {
    getReleaseMbidByDiscogsReleaseId: vi
      .fn()
      .mockImplementation(overrides.getReleaseMbid ?? (async () => null)),
    getRecordingsByReleaseMbid: vi
      .fn()
      .mockImplementation(overrides.getRecordings ?? (async () => [])),
    searchRecording: vi.fn().mockImplementation(overrides.search ?? (async () => null)),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

function mbTrack(partial: Partial<MbRecordingTrack> & { position: number }): MbRecordingTrack {
  return {
    title: 'Track',
    lengthSeconds: null,
    recordingMbid: `rec-${partial.position}`,
    isrc: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// normalizeForMatch
// ---------------------------------------------------------------------------
describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation and whitespace', () => {
    expect(normalizeForMatch('Blue in Green!')).toBe('blueingreen');
  });

  it('strips diacritics', () => {
    expect(normalizeForMatch('Café Olé')).toBe('cafeole');
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeForMatch('—()[]')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// titleSimilarity
// ---------------------------------------------------------------------------
describe('titleSimilarity', () => {
  it('returns 1 for an exact normalized match', () => {
    expect(titleSimilarity('So What', 'so what!')).toBe(1);
  });

  it('returns 0 when either title is empty after normalization', () => {
    expect(titleSimilarity('()', 'Real Title')).toBe(0);
  });

  it('scores near-identical titles highly', () => {
    expect(titleSimilarity('Freddie Freeloader', 'Freddie Freeloaderr')).toBeGreaterThan(0.85);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('So What', 'Flamenco Sketches')).toBeLessThan(0.5);
  });

  it('returns 0 when a single-character title yields no bigrams', () => {
    expect(titleSimilarity('a', 'bc')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isValidMatch
// ---------------------------------------------------------------------------
describe('isValidMatch', () => {
  it('accepts a title match within duration tolerance', () => {
    expect(
      isValidMatch(
        { title: 'So What', durationSeconds: 545 },
        { title: 'So What', lengthSeconds: 548 },
      ),
    ).toBe(true);
  });

  it('rejects a title match when durations diverge beyond tolerance', () => {
    expect(
      isValidMatch(
        { title: 'So What', durationSeconds: 545 },
        { title: 'So What', lengthSeconds: 600 },
      ),
    ).toBe(false);
  });

  it('rejects when titles are dissimilar even if durations match', () => {
    expect(
      isValidMatch(
        { title: 'So What', durationSeconds: 300 },
        { title: 'Blue in Green', lengthSeconds: 300 },
      ),
    ).toBe(false);
  });

  it('accepts on an exact title match when a duration is unknown', () => {
    expect(
      isValidMatch(
        { title: 'So What', durationSeconds: null },
        { title: 'so what', lengthSeconds: 545 },
      ),
    ).toBe(true);
  });

  it('rejects a near (non-exact) title match when a duration is unknown', () => {
    expect(
      isValidMatch(
        { title: 'Freddie Freeloader', durationSeconds: null },
        { title: 'Freddie Freeloaderr', lengthSeconds: null },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// alignTracklist
// ---------------------------------------------------------------------------
describe('alignTracklist', () => {
  const nodes: TrackForMusicBrainz[] = [
    { elementId: 'n2', title: 'Second', trackNumber: 2, durationSeconds: 200 },
    { elementId: 'n1', title: 'First', trackNumber: 1, durationSeconds: 100 },
  ];

  it('aligns nodes sorted by trackNumber against the MB tracklist', () => {
    const mb = [
      mbTrack({ position: 1, title: 'First', lengthSeconds: 100, recordingMbid: 'r1' }),
      mbTrack({
        position: 2,
        title: 'Second',
        lengthSeconds: 200,
        recordingMbid: 'r2',
        isrc: 'I2',
      }),
    ];

    expect(alignTracklist(nodes, mb)).toEqual([
      { elementId: 'n1', recordingMbid: 'r1', isrc: null },
      { elementId: 'n2', recordingMbid: 'r2', isrc: 'I2' },
    ]);
  });

  it('drops a mismatched pair rather than guessing an MBID', () => {
    const mb = [
      mbTrack({ position: 1, title: 'First', lengthSeconds: 100, recordingMbid: 'r1' }),
      mbTrack({ position: 2, title: 'Totally Different', lengthSeconds: 999, recordingMbid: 'r2' }),
    ];

    expect(alignTracklist(nodes, mb)).toEqual([
      { elementId: 'n1', recordingMbid: 'r1', isrc: null },
    ]);
  });

  it('only zips up to the shorter of the two tracklists', () => {
    const mb = [mbTrack({ position: 1, title: 'First', lengthSeconds: 100, recordingMbid: 'r1' })];
    expect(alignTracklist(nodes, mb)).toEqual([
      { elementId: 'n1', recordingMbid: 'r1', isrc: null },
    ]);
  });

  it('returns an empty array when there are no MB tracks', () => {
    expect(alignTracklist(nodes, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// enrichTrackMusicBrainz
// ---------------------------------------------------------------------------
describe('enrichTrackMusicBrainz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReleases.mockResolvedValue([]);
    mockSetIds.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no releases to enrich', async () => {
    const client = makeMbClient({});
    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(summary.releasesProcessed).toBe(0);
    expect(summary.releasesSkipped).toBe(0);
    expect(summary.releasesFailed).toBe(0);
    expect(summary.tracksMatched).toBe(0);
    expect(mockSetIds).not.toHaveBeenCalled();
  });

  it('matches tracks via the primary release-alignment path', async () => {
    mockGetReleases.mockResolvedValue([
      {
        releaseDiscogsId: 567,
        artistNames: ['Miles Davis'],
        tracks: [
          { elementId: 'n1', title: 'So What', trackNumber: 1, durationSeconds: 545 },
          { elementId: 'n2', title: 'Freddie Freeloader', trackNumber: 2, durationSeconds: 586 },
        ],
      },
    ]);
    const client = makeMbClient({
      getReleaseMbid: async () => 'rel-mbid',
      getRecordings: async () => [
        mbTrack({ position: 1, title: 'So What', lengthSeconds: 545, recordingMbid: 'r1' }),
        mbTrack({
          position: 2,
          title: 'Freddie Freeloader',
          lengthSeconds: 586,
          recordingMbid: 'r2',
          isrc: 'US-XXX-59-00002',
        }),
      ],
    });

    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(summary.releasesProcessed).toBe(1);
    expect(summary.tracksMatched).toBe(2);
    expect(summary.tracksUnmatched).toBe(0);
    expect(client.searchRecording).not.toHaveBeenCalled();
    expect(mockSetIds).toHaveBeenCalledWith(fakeDriver, [
      { elementId: 'n1', recordingMbid: 'r1', isrc: null },
      { elementId: 'n2', recordingMbid: 'r2', isrc: 'US-XXX-59-00002' },
    ]);
  });

  it('falls back to recording search for tracks the primary path misses', async () => {
    mockGetReleases.mockResolvedValue([
      {
        releaseDiscogsId: 567,
        artistNames: ['Miles Davis'],
        tracks: [{ elementId: 'n1', title: 'So What', trackNumber: 1, durationSeconds: 545 }],
      },
    ]);
    const client = makeMbClient({
      getReleaseMbid: async () => null,
      search: async () => ({ recordingMbid: 'rec-fallback', isrc: 'ISRC1' }),
    });

    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(client.getRecordingsByReleaseMbid).not.toHaveBeenCalled();
    expect(client.searchRecording).toHaveBeenCalledWith('So What', 'Miles Davis', 545);
    expect(summary.releasesProcessed).toBe(1);
    expect(summary.tracksMatched).toBe(1);
    expect(mockSetIds).toHaveBeenCalledWith(fakeDriver, [
      { elementId: 'n1', recordingMbid: 'rec-fallback', isrc: 'ISRC1' },
    ]);
  });

  it('skips (but still marks) a release with no matches at all', async () => {
    mockGetReleases.mockResolvedValue([
      {
        releaseDiscogsId: 567,
        artistNames: ['Unknown'],
        tracks: [{ elementId: 'n1', title: 'Obscure', trackNumber: 1, durationSeconds: 100 }],
      },
    ]);
    const client = makeMbClient({ getReleaseMbid: async () => null });

    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(summary.releasesProcessed).toBe(0);
    expect(summary.releasesSkipped).toBe(1);
    expect(summary.tracksUnmatched).toBe(1);
    expect(mockSetIds).toHaveBeenCalledWith(fakeDriver, [
      { elementId: 'n1', recordingMbid: null, isrc: null },
    ]);
  });

  it('skips the fallback when the release has no credited artist', async () => {
    mockGetReleases.mockResolvedValue([
      {
        releaseDiscogsId: 567,
        artistNames: [],
        tracks: [{ elementId: 'n1', title: 'Track', trackNumber: 1, durationSeconds: 100 }],
      },
    ]);
    const client = makeMbClient({ getReleaseMbid: async () => null });

    await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(client.searchRecording).not.toHaveBeenCalled();
  });

  it('counts a per-release failure and does not mark its tracks fetched', async () => {
    mockGetReleases.mockResolvedValue([
      {
        releaseDiscogsId: 567,
        artistNames: ['X'],
        tracks: [{ elementId: 'n1', title: 'Track', trackNumber: 1, durationSeconds: 100 }],
      },
    ]);
    const client = makeMbClient({
      getReleaseMbid: async () => {
        throw new Error('MB API timeout');
      },
    });

    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(summary.releasesFailed).toBe(1);
    expect(summary.releasesProcessed).toBe(0);
    expect(mockSetIds).not.toHaveBeenCalled();
  });

  it('continues processing after a per-release failure', async () => {
    mockGetReleases.mockResolvedValue([
      {
        releaseDiscogsId: 1,
        artistNames: ['X'],
        tracks: [{ elementId: 'n1', title: 'A', trackNumber: 1, durationSeconds: 100 }],
      },
      {
        releaseDiscogsId: 2,
        artistNames: ['Y'],
        tracks: [{ elementId: 'n2', title: 'B', trackNumber: 1, durationSeconds: 200 }],
      },
    ]);
    const client = makeMbClient({
      getReleaseMbid: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('rel-mbid-2'),
      getRecordings: async () => [
        mbTrack({ position: 1, title: 'B', lengthSeconds: 200, recordingMbid: 'r-b' }),
      ],
    });

    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(summary.releasesFailed).toBe(1);
    expect(summary.releasesProcessed).toBe(1);
    expect(mockSetIds).toHaveBeenCalledTimes(1);
  });

  it('returns early with failed=1 when fetching releases fails', async () => {
    mockGetReleases.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient({});

    const summary = await enrichTrackMusicBrainz(client, fakeDriver, silentLogger);

    expect(summary.releasesFailed).toBe(1);
    expect(client.getReleaseMbidByDiscogsReleaseId).not.toHaveBeenCalled();
  });
});
