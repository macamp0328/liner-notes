import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedMasters,
  mergeMasterData,
  setMasterFetchedAndOriginalYear,
  setMasterFetched,
  buildReleasedInRows,
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

  it('selects releases still missing originalYear, gated by the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await getUnenrichedMasters(driver);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(query).toContain('masterDiscogsId IS NOT NULL');
    expect(query).toContain('r.originalYear IS NULL');
    expect(query).toContain('r.masterFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(params).toHaveProperty('stalenessDays');
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

  it('runs MERGE for Master node then UNWIND for country relationships', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    const countriesWithFormats = [
      { country: 'US', formats: ['Vinyl', 'CD'] },
      { country: 'GB', formats: ['Vinyl'] },
    ];

    await mergeMasterData(driver, 100, 'Hejira', 1976, countriesWithFormats);

    // 1 Master MERGE + 1 UNWIND for all countries = 2 total
    expect(runSpy).toHaveBeenCalledTimes(2);

    const masterMergeQuery: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(masterMergeQuery).toContain('MERGE (m:Master');
    expect(masterMergeQuery).toContain('SET m.title');

    const relQuery: string = runSpy.mock.calls[1]?.[0] ?? '';
    expect(relQuery).toContain('UNWIND');
    expect(relQuery).toContain('RELEASED_IN');
    expect(relQuery).toContain('SET rel.formats');
  });

  it('fans out a compound market to both RELEASED_IN and RELEASED_IN_REGION (#441)', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    // "UK & Europe" → Country GB + Region EU.
    await mergeMasterData(driver, 100, 'Hejira', 1976, [
      { country: 'UK & Europe', formats: ['Vinyl'] },
    ]);

    // Master MERGE + country UNWIND + region UNWIND = 3.
    expect(runSpy).toHaveBeenCalledTimes(3);
    const countryQuery: string = runSpy.mock.calls[1]?.[0] ?? '';
    const regionQuery: string = runSpy.mock.calls[2]?.[0] ?? '';
    expect(countryQuery).toContain('RELEASED_IN]');
    expect((runSpy.mock.calls[1]?.[1] as { rows: { code: string }[] }).rows[0]?.code).toBe('GB');
    expect(regionQuery).toContain('RELEASED_IN_REGION]');
    expect((runSpy.mock.calls[2]?.[1] as { rows: { code: string }[] }).rows[0]?.code).toBe('EU');
  });

  it('runs only the Master MERGE when countriesWithFormats is empty', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await mergeMasterData(driver, 100, 'Hejira', 1976, []);

    expect(runSpy).toHaveBeenCalledTimes(1);
    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('MERGE (m:Master');
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
// buildReleasedInRows
// ---------------------------------------------------------------------------

describe('buildReleasedInRows', () => {
  it('normalises to ISO and unions formats when raws collapse onto one code', () => {
    // UK + England both → GB; their formats must union onto the single GB row (no clobber).
    const { countryRows, regionRows } = buildReleasedInRows([
      { country: 'UK', formats: ['LP'] },
      { country: 'England', formats: ['CD'] },
    ]);
    expect(regionRows).toEqual([]);
    expect(countryRows).toHaveLength(1);
    expect(countryRows[0]?.code).toBe('GB');
    expect([...countryRows[0]!.formats].sort()).toEqual(['CD', 'LP']);
  });

  it('splits a compound market into country and region rows', () => {
    const { countryRows, regionRows } = buildReleasedInRows([
      { country: 'UK & Europe', formats: ['Vinyl'] },
    ]);
    expect(countryRows).toEqual([{ code: 'GB', formats: ['Vinyl'] }]);
    expect(regionRows).toEqual([{ code: 'EU', formats: ['Vinyl'] }]);
  });
});

// ---------------------------------------------------------------------------
// setMasterFetchedAndOriginalYear
// ---------------------------------------------------------------------------

describe('setMasterFetchedAndOriginalYear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs SET query that stamps masterFetchedAt and sets originalYear', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await setMasterFetchedAndOriginalYear(driver, [13570466, 9999991], 1976);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('masterFetchedAt = datetime()');
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

// ---------------------------------------------------------------------------
// setMasterFetched
// ---------------------------------------------------------------------------

describe('setMasterFetched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps only masterFetchedAt without touching originalYear', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await setMasterFetched(driver, [13570466]);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('masterFetchedAt = datetime()');
    expect(query).not.toContain('originalYear');

    const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    const releaseIds = params['releaseIds'] as Array<{ toNumber(): number }>;
    expect(releaseIds.map((id) => id.toNumber())).toEqual([13570466]);
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(setMasterFetched(driver, [1])).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
