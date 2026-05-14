import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedMasters,
  mergeMasterData,
  setMasterFetchedAndOriginalYear,
} from '../../../src/db/master-data-repository.js';

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

function makeMockSession(runResult: unknown = { records: [] }): {
  session: Session;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = vi.fn().mockResolvedValue(runResult);
  const session = {
    run: runSpy,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

function makeNeo4jInt(n: number) {
  return { toNumber: () => n, low: n, high: 0 };
}

// ---------------------------------------------------------------------------
// getUnenrichedMasters
// ---------------------------------------------------------------------------

describe('getUnenrichedMasters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped UnenrichedMaster[] from query records', async () => {
    const record = makeRecord({
      masterDiscogsId: makeNeo4jInt(100),
      releaseIds: [makeNeo4jInt(13570466), makeNeo4jInt(9999991)],
    });
    const { session } = makeMockSession({ records: [record] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedMasters(driver);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      masterDiscogsId: 100,
      releaseIds: [13570466, 9999991],
    });
  });

  it('returns empty array when no releases need enrichment', async () => {
    const { session } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedMasters(driver);
    expect(result).toEqual([]);
  });

  it('sends a query that filters by masterFetched IS NULL', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await getUnenrichedMasters(driver);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('masterFetched IS NULL');
    expect(query).toContain('masterDiscogsId IS NOT NULL');
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(getUnenrichedMasters(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// mergeMasterData
// ---------------------------------------------------------------------------

describe('mergeMasterData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs MERGE for Master node and a RELEASED_IN write for each country', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    const countriesWithFormats = [
      { country: 'US', formats: ['Vinyl', 'CD'] },
      { country: 'GB', formats: ['Vinyl'] },
    ];

    await mergeMasterData(driver, 100, 'Hejira', 1976, countriesWithFormats);

    // 1 MERGE for Master + 2 RELEASED_IN writes = 3 total
    expect(runSpy).toHaveBeenCalledTimes(3);

    const masterMergeQuery: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(masterMergeQuery).toContain('MERGE (m:Master');
    expect(masterMergeQuery).toContain('SET m.title');

    const relQuery: string = runSpy.mock.calls[1]?.[0] ?? '';
    expect(relQuery).toContain('RELEASED_IN');
    expect(relQuery).toContain('SET rel.formats');
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(mergeMasterData(driver, 100, 'Title', 1976, [])).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setMasterFetchedAndOriginalYear
// ---------------------------------------------------------------------------

describe('setMasterFetchedAndOriginalYear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs SET query that sets both masterFetched and originalYear', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await setMasterFetchedAndOriginalYear(driver, [13570466, 9999991], 1976);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('masterFetched');
    expect(query).toContain('originalYear');

    const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect((params['originalYear'] as { toNumber(): number }).toNumber()).toBe(1976);

    const releaseIds = params['releaseIds'] as Array<{ toNumber(): number }>;
    expect(releaseIds.map((id) => id.toNumber())).toEqual([13570466, 9999991]);
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(setMasterFetchedAndOriginalYear(driver, [1], 1970)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
