import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getReleasesByMusician,
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
