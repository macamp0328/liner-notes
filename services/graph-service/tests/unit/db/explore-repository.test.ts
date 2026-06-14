import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getReleasesByMusician,
  getReleasesByCredit,
  getReleasesByInstrument,
  getRecordingsByWork,
  getReleasesByStudio,
  getReleasesByLabel,
  getReleasesByGenre,
  getReleasesByStyle,
  getReleasesByCountry,
  getReleasesByDecade,
  getReleasesByYear,
  getConnections,
  getSharedMusicians,
  getMostPressedReleases,
  getTracksByAudioFeatures,
} from '../../../src/db/repositories/explore-repository.js';

vi.mock('neo4j-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('neo4j-driver')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      int: (n: number) => ({ toNumber: () => n, low: n, high: 0 }),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSession(runResults: unknown[] = []): {
  session: Session;
  runSpy: ReturnType<typeof vi.fn>;
} {
  let callIndex = 0;
  const runSpy = vi.fn().mockImplementation(() => {
    const result = runResults[callIndex] ?? { records: [] };
    callIndex++;
    return Promise.resolve(result);
  });
  const session = {
    run: runSpy,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeNeo4jInt(n: number) {
  return { toNumber: () => n, low: n, high: 0 };
}

function makeRecord(fields: Record<string, unknown>): Neo4jRecord {
  return { get: (key: string) => fields[key] } as unknown as Neo4jRecord;
}

function makeResult(records: Neo4jRecord[]): Result {
  return { records } as unknown as Result;
}

const sampleReleaseRecord = {
  discogsId: makeNeo4jInt(13570466),
  title: 'U.F.O.F.',
  artist: 'Big Thief',
  pressingYear: makeNeo4jInt(2019),
  format: 'Vinyl',
  thumbUrl: 'https://example.com/thumb.jpg',
};

// ---------------------------------------------------------------------------
// getReleasesByMusician
// ---------------------------------------------------------------------------

describe('getReleasesByMusician', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns musician releases with instrument and role', async () => {
    const rec = makeRecord({
      ...sampleReleaseRecord,
      instrument: 'Tenor Saxophone',
      role: 'performer',
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByMusician(driver, 'John Coltrane');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      discogsId: 13570466,
      title: 'U.F.O.F.',
      artist: 'Big Thief',
      pressingYear: 2019,
      instrument: 'Tenor Saxophone',
      role: 'performer',
    });
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByMusician(driver, 'Unknown Musician');
    expect(results).toHaveLength(0);
  });

  it('handles null instrument and role', async () => {
    const rec = makeRecord({
      ...sampleReleaseRecord,
      instrument: null,
      role: null,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByMusician(driver, 'Some Musician');
    expect(results).toHaveLength(1);
    expect(results[0]!.instrument).toBeNull();
    expect(results[0]!.role).toBeNull();
  });

  it('closes the session', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await getReleasesByMusician(driver, 'Test');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getReleasesByCredit
// ---------------------------------------------------------------------------

describe('getReleasesByCredit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns credited releases with instrument and role', async () => {
    const rec = makeRecord({
      ...sampleReleaseRecord,
      instrument: 'Producer',
      role: 'producer',
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByCredit(driver, 'Andrew Sarlo', 'producer');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      discogsId: 13570466,
      title: 'U.F.O.F.',
      instrument: 'Producer',
      role: 'producer',
    });
  });

  it('filters by name and roleCategory', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await getReleasesByCredit(driver, 'Andrew Sarlo', 'producer');
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('c.roleCategory = $roleCategory');
    expect(query).toContain('toLower(m.name) = toLower($name)');
    expect(params).toEqual({ name: 'Andrew Sarlo', roleCategory: 'producer' });
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByCredit(driver, 'Nobody', 'engineer');
    expect(results).toHaveLength(0);
  });

  it('closes the session', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await getReleasesByCredit(driver, 'Test', 'engineer');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getReleasesByInstrument
// ---------------------------------------------------------------------------

describe('getReleasesByInstrument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns instrument credits with musician, displayRole and scope', async () => {
    const rec = makeRecord({
      ...sampleReleaseRecord,
      musician: 'Ron Carter',
      instrument: 'bass',
      displayRole: 'Upright Bass',
      scope: 'release',
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByInstrument(driver, 'bass');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      discogsId: 13570466,
      title: 'U.F.O.F.',
      musician: 'Ron Carter',
      instrument: 'bass',
      displayRole: 'Upright Bass',
      scope: 'release',
    });
  });

  it('filters on the normalized instrument, lowercasing the param', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await getReleasesByInstrument(driver, 'Bass');
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('c.instrument = toLower($instrument)');
    expect(params).toEqual({ instrument: 'Bass' });
  });

  it('defaults a missing musician name to an empty string', async () => {
    const rec = makeRecord({
      ...sampleReleaseRecord,
      musician: null,
      instrument: 'bass',
      displayRole: null,
      scope: null,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByInstrument(driver, 'bass');
    expect(results[0]!.musician).toBe('');
    expect(results[0]!.displayRole).toBeNull();
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByInstrument(driver, 'harp');
    expect(results).toHaveLength(0);
  });

  it('closes the session', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await getReleasesByInstrument(driver, 'bass');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getRecordingsByWork (#336)
// ---------------------------------------------------------------------------

describe('getRecordingsByWork', () => {
  it('maps work recordings and passes the mbid through', async () => {
    const rec = makeRecord({
      workTitle: 'Who Do You Love?',
      recordingMbid: 'rec-1',
      trackTitle: 'Who Do You Love',
      position: 'A1',
      discogsId: makeNeo4jInt(7000001),
      releaseTitle: 'La Bamba',
      artist: 'Bo Diddley',
      year: makeNeo4jInt(1987),
      thumbUrl: null,
    });
    const { session, runSpy } = makeMockSession([makeResult([rec])]);

    const out = await getRecordingsByWork(makeMockDriver(session), 'work-1');

    expect(out).toEqual([
      {
        workTitle: 'Who Do You Love?',
        recordingMbid: 'rec-1',
        trackTitle: 'Who Do You Love',
        position: 'A1',
        discogsId: 7000001,
        releaseTitle: 'La Bamba',
        artist: 'Bo Diddley',
        year: 1987,
        thumbUrl: null,
      },
    ]);
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('RECORDING_OF');
    expect(query).toContain('Work {mbid: $mbid}');
    expect(params).toEqual({ mbid: 'work-1' });
  });

  it('returns an empty array for an unknown work', async () => {
    const { session } = makeMockSession([makeResult([])]);
    expect(await getRecordingsByWork(makeMockDriver(session), 'nope')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getReleasesByStudio
// ---------------------------------------------------------------------------

describe('getReleasesByStudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a studio', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByStudio(driver, 'Capitol Studios');
    expect(results).toHaveLength(1);
    expect(results[0]!.discogsId).toBe(13570466);
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByStudio(driver, 'Unknown Studio');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReleasesByLabel
// ---------------------------------------------------------------------------

describe('getReleasesByLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a label', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByLabel(driver, '4AD');
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('U.F.O.F.');
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByLabel(driver, 'Unknown Label');
    expect(results).toHaveLength(0);
  });

  it('uses the exact-label query by default (no family roll-up)', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    await getReleasesByLabel(makeMockDriver(session), '4AD');
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('MATCH (r:Release)-[:ON_LABEL]->(l:Label)');
    expect(query).not.toContain('PARENT_LABEL');
  });

  it('rolls up the label family when includeSublabels is true', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session, runSpy } = makeMockSession([makeResult([rec])]);
    const results = await getReleasesByLabel(makeMockDriver(session), 'Columbia', true);
    expect(results).toHaveLength(1);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('(fam)-[:PARENT_LABEL*1..4]-(seed)');
    expect(query).toContain('RETURN DISTINCT');
  });
});

// ---------------------------------------------------------------------------
// getReleasesByGenre
// ---------------------------------------------------------------------------

describe('getReleasesByGenre', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a genre', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByGenre(driver, 'Jazz');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByGenre(driver, 'Unknown Genre');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReleasesByStyle
// ---------------------------------------------------------------------------

describe('getReleasesByStyle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a style', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByStyle(driver, 'Hard Bop');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByStyle(driver, 'Unknown Style');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReleasesByCountry
// ---------------------------------------------------------------------------

describe('getReleasesByCountry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a country', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByCountry(driver, 'US');
    expect(results).toHaveLength(1);
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByCountry(driver, 'Unknown Country');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReleasesByDecade
// ---------------------------------------------------------------------------

describe('getReleasesByDecade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a decade', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByDecade(driver, '2010s');
    expect(results).toHaveLength(1);
    expect(results[0]!.pressingYear).toBe(2019);
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByDecade(driver, '1800s');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReleasesByYear
// ---------------------------------------------------------------------------

describe('getReleasesByYear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns releases for a specific year', async () => {
    const rec = makeRecord(sampleReleaseRecord);
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByYear(driver, 2019);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('U.F.O.F.');
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getReleasesByYear(driver, 1800);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getConnections
// ---------------------------------------------------------------------------

describe('getConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns seed and connected nodes', async () => {
    const rec = makeRecord({
      discogsId: makeNeo4jInt(13570466),
      title: 'U.F.O.F.',
      artist: 'Big Thief',
      pressingYear: makeNeo4jInt(2019),
      format: 'Vinyl',
      thumbUrl: null,
      nodes: [
        { type: 'Musician', discogsId: null, name: 'John Smith', title: null },
        { type: 'Release', discogsId: makeNeo4jInt(9999991), name: null, title: 'Other Album' },
      ],
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const result = await getConnections(driver, 13570466, 2);
    expect(result).not.toBeNull();
    expect(result!.seed.discogsId).toBe(13570466);
    expect(result!.nodes).toHaveLength(2);
    expect(result!.nodes[0]).toMatchObject({ type: 'Musician', name: 'John Smith' });
    expect(result!.nodes[1]).toMatchObject({ type: 'Release', title: 'Other Album' });
  });

  it('returns null when release not found', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const result = await getConnections(driver, 99999, 1);
    expect(result).toBeNull();
  });

  it('filters out null-type nodes from connected list', async () => {
    const rec = makeRecord({
      discogsId: makeNeo4jInt(13570466),
      title: 'U.F.O.F.',
      artist: null,
      pressingYear: null,
      format: null,
      thumbUrl: null,
      nodes: [{ type: null, discogsId: null, name: null, title: null }],
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const result = await getConnections(driver, 13570466, 1);
    expect(result!.nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getSharedMusicians
// ---------------------------------------------------------------------------

describe('getSharedMusicians', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns shared musician pairs', async () => {
    const rec = makeRecord({
      releaseAId: makeNeo4jInt(13570466),
      releaseATitle: 'U.F.O.F.',
      releaseBId: makeNeo4jInt(9999991),
      releaseBTitle: 'Other Album',
      sharedMusicians: [
        { name: 'John Smith', instrument: 'Guitar' },
        { name: 'Jane Doe', instrument: null },
      ],
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await getSharedMusicians(driver);
    expect(results).toHaveLength(1);
    expect(results[0]!.releaseA.discogsId).toBe(13570466);
    expect(results[0]!.releaseB.title).toBe('Other Album');
    expect(results[0]!.sharedMusicians).toHaveLength(2);
    expect(results[0]!.sharedMusicians[0]).toEqual({ name: 'John Smith', instrument: 'Guitar' });
    expect(results[0]!.sharedMusicians[1]).toEqual({ name: 'Jane Doe', instrument: null });
  });

  it('returns empty array when no shared musicians', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await getSharedMusicians(driver);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getMostPressedReleases
// ---------------------------------------------------------------------------

describe('getMostPressedReleases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped MostPressedRelease[] grouped by master', async () => {
    const rec = makeRecord({
      masterDiscogsId: makeNeo4jInt(100),
      albumTitle: 'Hejira',
      countryCount: makeNeo4jInt(15),
      countries: ['US', 'GB', 'DE'],
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);

    const results = await getMostPressedReleases(driver, 10);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      masterDiscogsId: 100,
      albumTitle: 'Hejira',
      countryCount: 15,
      countries: ['US', 'GB', 'DE'],
    });
  });

  it('returns empty array when no masters have multi-country pressings', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    const results = await getMostPressedReleases(driver, 10);
    expect(results).toHaveLength(0);
  });

  it('uses RELEASED_IN relationship and groups by master', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    await getMostPressedReleases(driver, 5);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('RELEASED_IN');
    expect(query).toContain('Master');
  });
});

// ---------------------------------------------------------------------------
// getTracksByAudioFeatures
// ---------------------------------------------------------------------------

describe('getTracksByAudioFeatures', () => {
  it('returns mapped AudioFeatureTrack[] for a single result', async () => {
    const rec = makeRecord({
      trackTitle: 'Birdland',
      releaseTitle: 'Heavy Weather',
      releaseDiscogsId: makeNeo4jInt(12345),
      tempo: 132.7,
      musicalKey: 'C',
      musicalScale: 'major',
      loudnessDb: -12.3,
      danceabilityEstimate: 0.78,
      voiceInstrumental: 'instrumental',
      deezerBpm: 130.0,
      deezerGain: -8.5,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);

    const results = await getTracksByAudioFeatures(driver, {}, 20);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      trackTitle: 'Birdland',
      releaseTitle: 'Heavy Weather',
      releaseDiscogsId: 12345,
      tempo: 132.7,
      musicalKey: 'C',
      musicalScale: 'major',
      loudnessDb: -12.3,
      danceabilityEstimate: 0.78,
      voiceInstrumental: 'instrumental',
      deezerBpm: 130.0,
      deezerGain: -8.5,
    });
  });

  it('returns empty array when no tracks match', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    const results = await getTracksByAudioFeatures(driver, {}, 20);
    expect(results).toHaveLength(0);
  });

  it('passes minTempo and maxTempo to the query params', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    await getTracksByAudioFeatures(driver, { minTempo: 100, maxTempo: 130 }, 10);

    const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params['minTempo']).toBe(100);
    expect(params['maxTempo']).toBe(130);
  });

  it('uses a combined per-source AND condition when both minTempo and maxTempo are provided', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    await getTracksByAudioFeatures(driver, { minTempo: 90, maxTempo: 120 }, 10);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('t.tempo >= $minTempo AND t.tempo <= $maxTempo');
    expect(query).toContain('t.deezerBpm >= $minTempo AND t.deezerBpm <= $maxTempo');
  });

  it('passes key, scale, voiceInstrumental, and minDanceability filters', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    await getTracksByAudioFeatures(
      driver,
      { key: 'A', scale: 'minor', voiceInstrumental: 'voice', minDanceability: 0.6 },
      10,
    );

    const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params['key']).toBe('A');
    expect(params['scale']).toBe('minor');
    expect(params['voiceInstrumental']).toBe('voice');
    expect(params['minDanceability']).toBe(0.6);
  });

  it('handles null audio feature fields gracefully', async () => {
    const rec = makeRecord({
      trackTitle: 'Mystery Track',
      releaseTitle: 'Unknown Album',
      releaseDiscogsId: makeNeo4jInt(99),
      tempo: null,
      musicalKey: null,
      musicalScale: null,
      loudnessDb: null,
      danceabilityEstimate: null,
      voiceInstrumental: null,
      deezerBpm: 98.0,
      deezerGain: null,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);

    const results = await getTracksByAudioFeatures(driver, {}, 20);

    expect(results[0]?.tempo).toBeNull();
    expect(results[0]?.deezerBpm).toBe(98.0);
  });

  it('closes the session after the query', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    await getTracksByAudioFeatures(driver, {}, 10);

    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
