import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  listReleases,
  getReleaseById,
  getArtistById,
  getLabelById,
} from '../../../src/db/repositories/collection-repository.js';

// ---------------------------------------------------------------------------
// Mock neo4j-driver — test Cypher structure, not Neo4j execution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// listReleases
// ---------------------------------------------------------------------------

describe('listReleases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns items and total from two queries', async () => {
    const countRecord = makeRecord({ total: makeNeo4jInt(42) });
    const dataRecord = makeRecord({
      discogsId: makeNeo4jInt(13570466),
      title: 'U.F.O.F.',
      year: makeNeo4jInt(2019),
      format: 'Vinyl',
      thumbUrl: 'https://example.com/thumb.jpg',
      artistNames: ['Big Thief'],
      labelNames: ['4AD'],
    });

    const { session } = makeMockSession([makeResult([countRecord]), makeResult([dataRecord])]);
    const driver = makeMockDriver(session);

    const { items, total } = await listReleases(driver, 0, 20);

    expect(total).toBe(42);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      discogsId: 13570466,
      title: 'U.F.O.F.',
      year: 2019,
      format: 'Vinyl',
      thumbUrl: 'https://example.com/thumb.jpg',
      artistName: 'Big Thief',
      labelName: '4AD',
    });
  });

  it('passes correct SKIP and LIMIT params', async () => {
    const { session, runSpy } = makeMockSession([
      makeResult([makeRecord({ total: makeNeo4jInt(0) })]),
      makeResult([]),
    ]);
    const driver = makeMockDriver(session);

    await listReleases(driver, 40, 10);

    const dataCallArgs = runSpy.mock.calls[1] ?? [];
    expect(dataCallArgs[1]).toMatchObject({
      skip: { low: 40 },
      limit: { low: 10 },
    });
  });

  it('returns empty items and zero total when no releases exist', async () => {
    const { session } = makeMockSession([
      makeResult([makeRecord({ total: makeNeo4jInt(0) })]),
      makeResult([]),
    ]);
    const driver = makeMockDriver(session);

    const { items, total } = await listReleases(driver, 0, 20);

    expect(total).toBe(0);
    expect(items).toEqual([]);
  });

  it('handles null optional fields on list items', async () => {
    const dataRecord = makeRecord({
      discogsId: makeNeo4jInt(1),
      title: 'Title',
      year: null,
      format: null,
      thumbUrl: null,
      artistNames: [],
      labelNames: [],
    });

    const { session } = makeMockSession([
      makeResult([makeRecord({ total: makeNeo4jInt(1) })]),
      makeResult([dataRecord]),
    ]);
    const driver = makeMockDriver(session);

    const { items } = await listReleases(driver, 0, 20);

    expect(items[0]).toMatchObject({
      year: null,
      format: null,
      thumbUrl: null,
      artistName: null,
      labelName: null,
    });
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(listReleases(driver, 0, 20)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getReleaseById
// ---------------------------------------------------------------------------

describe('getReleaseById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCoreRecord() {
    return makeRecord({
      r: {
        properties: {
          discogsId: makeNeo4jInt(13570466),
          title: 'U.F.O.F.',
          year: makeNeo4jInt(2019),
          format: 'Vinyl',
          thumbUrl: 'https://example.com/thumb.jpg',
          masterDiscogsId: makeNeo4jInt(1234),
          releaseDate: '2019-05-03',
          notes: null,
          discogsUrl: 'https://www.discogs.com/release/13570466',
          communityRating: 4.5,
          communityRatingCount: makeNeo4jInt(10),
          barcode: null,
        },
      },
      artists: [{ discogsId: makeNeo4jInt(5009441), name: 'Big Thief', role: '' }],
      labels: [{ discogsId: makeNeo4jInt(634), name: '4AD', catalogNumber: '4AD0129LP' }],
      genres: ['Rock'],
      styles: ['Indie Rock'],
      country: 'US',
      decade: '2010s',
      studios: ['Bear Creek Studios'],
      credits: [],
    });
  }

  it('returns null when release not found', async () => {
    const { session } = makeMockSession([makeResult([]), makeResult([])]);
    const driver = makeMockDriver(session);

    const result = await getReleaseById(driver, 999);
    expect(result).toBeNull();
  });

  it('returns full release with artists and labels', async () => {
    const trackRecord = makeRecord({
      position: 'A1',
      title: 'Contact',
      duration: '4:02',
      lyrics: null,
      lyricsSource: null,
      musicians: [],
    });

    const { session } = makeMockSession([
      makeResult([makeCoreRecord()]),
      makeResult([trackRecord]),
    ]);
    const driver = makeMockDriver(session);

    const release = await getReleaseById(driver, 13570466);

    expect(release).not.toBeNull();
    expect(release?.discogsId).toBe(13570466);
    expect(release?.title).toBe('U.F.O.F.');
    expect(release?.year).toBe(2019);
    expect(release?.artists).toHaveLength(1);
    expect(release?.artists[0]).toMatchObject({ discogsId: 5009441, name: 'Big Thief' });
    expect(release?.labels[0]).toMatchObject({ discogsId: 634, name: '4AD' });
    expect(release?.genres).toEqual(['Rock']);
    expect(release?.styles).toEqual(['Indie Rock']);
    expect(release?.country).toBe('US');
    expect(release?.decade).toBe('2010s');
    expect(release?.studios).toEqual(['Bear Creek Studios']);
    expect(release?.tracks).toHaveLength(1);
    expect(release?.tracks[0]).toMatchObject({ position: 'A1', title: 'Contact' });
  });

  it('filters out null-map entries from collect(DISTINCT {...})', async () => {
    const coreRecord = makeRecord({
      r: {
        properties: {
          discogsId: makeNeo4jInt(1),
          title: 'Test',
          year: null,
          format: null,
          thumbUrl: null,
          masterDiscogsId: null,
          releaseDate: null,
          notes: null,
          discogsUrl: null,
          communityRating: null,
          communityRatingCount: null,
          barcode: null,
        },
      },
      artists: [{ discogsId: null, name: null, role: null }],
      labels: [{ discogsId: null, name: null, catalogNumber: null }],
      genres: [null],
      styles: [null],
      country: null,
      decade: null,
      studios: [null],
      credits: [{ name: null, role: null, displayRole: null, creditedAs: null }],
    });

    const { session } = makeMockSession([makeResult([coreRecord]), makeResult([])]);
    const driver = makeMockDriver(session);

    const release = await getReleaseById(driver, 1);

    expect(release?.artists).toEqual([]);
    expect(release?.labels).toEqual([]);
    expect(release?.genres).toEqual([]);
    expect(release?.styles).toEqual([]);
    expect(release?.studios).toEqual([]);
    expect(release?.credits).toEqual([]);
  });

  it('populates track musicians correctly', async () => {
    const trackRecord = makeRecord({
      position: 'A1',
      title: 'Song',
      duration: null,
      lyrics: null,
      lyricsSource: null,
      musicians: [{ name: 'Jane', role: 'Guitar, Bass', displayRole: 'Guitar', creditedAs: null }],
    });

    const { session } = makeMockSession([
      makeResult([makeCoreRecord()]),
      makeResult([trackRecord]),
    ]);
    const driver = makeMockDriver(session);

    const release = await getReleaseById(driver, 13570466);

    const firstTrack = release?.tracks[0];
    expect(firstTrack?.musicians).toHaveLength(1);
    expect(firstTrack?.musicians[0]).toMatchObject({ name: 'Jane', displayRole: 'Guitar' });
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(getReleaseById(driver, 1)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getArtistById
// ---------------------------------------------------------------------------

describe('getArtistById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when artist not found', async () => {
    const { session } = makeMockSession([makeResult([]), makeResult([])]);
    const driver = makeMockDriver(session);

    expect(await getArtistById(driver, 999)).toBeNull();
  });

  it('returns artist with releases and empty credits when no SAME_PERSON_AS links', async () => {
    const artistRecord = makeRecord({
      discogsId: makeNeo4jInt(5009441),
      name: 'Big Thief',
      realName: null,
      profile: 'Band from Brooklyn',
      releases: [
        {
          discogsId: makeNeo4jInt(13570466),
          title: 'U.F.O.F.',
          year: makeNeo4jInt(2019),
          format: 'Vinyl',
          thumbUrl: null,
          role: '',
        },
      ],
    });

    const { session } = makeMockSession([makeResult([artistRecord]), makeResult([])]);
    const driver = makeMockDriver(session);

    const artist = await getArtistById(driver, 5009441);

    expect(artist?.discogsId).toBe(5009441);
    expect(artist?.name).toBe('Big Thief');
    expect(artist?.releases).toHaveLength(1);
    expect(artist?.releases[0]?.discogsId).toBe(13570466);
    expect(artist?.credits).toEqual([]);
  });

  it('returns artist with credits when SAME_PERSON_AS links exist', async () => {
    const artistRecord = makeRecord({
      discogsId: makeNeo4jInt(100),
      name: 'David Bowie',
      realName: 'David Robert Jones',
      profile: null,
      releases: [],
    });

    const creditRecord = makeRecord({
      releaseDiscogsId: makeNeo4jInt(200),
      releaseTitle: 'Some Album',
      role: 'Guitar, Vocals',
      displayRole: 'Guitar',
      creditedAs: 'Ziggy',
      scope: 'release',
    });

    const { session } = makeMockSession([makeResult([artistRecord]), makeResult([creditRecord])]);
    const driver = makeMockDriver(session);

    const artist = await getArtistById(driver, 100);

    expect(artist?.credits).toHaveLength(1);
    expect(artist?.credits[0]).toMatchObject({
      releaseDiscogsId: 200,
      releaseTitle: 'Some Album',
      creditedAs: 'Ziggy',
      scope: 'release',
    });
  });

  it('filters out null-map release entries', async () => {
    const artistRecord = makeRecord({
      discogsId: makeNeo4jInt(1),
      name: 'Solo Artist',
      realName: null,
      profile: null,
      releases: [
        { discogsId: null, title: null, year: null, format: null, thumbUrl: null, role: null },
      ],
    });

    const { session } = makeMockSession([makeResult([artistRecord]), makeResult([])]);
    const driver = makeMockDriver(session);

    const artist = await getArtistById(driver, 1);
    expect(artist?.releases).toEqual([]);
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(getArtistById(driver, 1)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getLabelById
// ---------------------------------------------------------------------------

describe('getLabelById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when label not found', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);

    expect(await getLabelById(driver, 999)).toBeNull();
  });

  it('returns label with releases', async () => {
    const labelRecord = makeRecord({
      discogsId: makeNeo4jInt(634),
      name: '4AD',
      profile: 'UK label',
      contactInfo: null,
      releases: [
        {
          discogsId: makeNeo4jInt(13570466),
          title: 'U.F.O.F.',
          year: makeNeo4jInt(2019),
          format: 'Vinyl',
          thumbUrl: null,
          catalogNumber: '4AD0129LP',
          artistNames: ['Big Thief'],
        },
      ],
    });

    const { session } = makeMockSession([makeResult([labelRecord])]);
    const driver = makeMockDriver(session);

    const label = await getLabelById(driver, 634);

    expect(label?.discogsId).toBe(634);
    expect(label?.name).toBe('4AD');
    expect(label?.profile).toBe('UK label');
    expect(label?.releases).toHaveLength(1);
    expect(label?.releases[0]).toMatchObject({
      discogsId: 13570466,
      catalogNumber: '4AD0129LP',
      artistName: 'Big Thief',
    });
  });

  it('filters out null-map release entries', async () => {
    const labelRecord = makeRecord({
      discogsId: makeNeo4jInt(1),
      name: 'Empty Label',
      profile: null,
      contactInfo: null,
      releases: [
        {
          discogsId: null,
          title: null,
          year: null,
          format: null,
          thumbUrl: null,
          catalogNumber: null,
          artistNames: [],
        },
      ],
    });

    const { session } = makeMockSession([makeResult([labelRecord])]);
    const driver = makeMockDriver(session);

    const label = await getLabelById(driver, 1);
    expect(label?.releases).toEqual([]);
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(getLabelById(driver, 1)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
