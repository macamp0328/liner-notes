import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedReleases,
  setOriginalYear,
} from '../../../src/db/original-year-repository.js';

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
// getUnenrichedReleases
// ---------------------------------------------------------------------------

describe('getUnenrichedReleases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped UnenrichedRelease[] from query records', async () => {
    const record = makeRecord({
      discogsId: makeNeo4jInt(13570466),
      masterDiscogsId: makeNeo4jInt(99999),
    });
    const { session } = makeMockSession({ records: [record] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedReleases(driver);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ discogsId: 13570466, masterDiscogsId: 99999 });
  });

  it('returns empty array when all releases already have originalYear', async () => {
    const { session } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedReleases(driver);
    expect(result).toEqual([]);
  });

  it('sends a query that filters by originalYear IS NULL and masterDiscogsId IS NOT NULL', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await getUnenrichedReleases(driver);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('originalYear IS NULL');
    expect(query).toContain('masterDiscogsId IS NOT NULL');
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(getUnenrichedReleases(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setOriginalYear
// ---------------------------------------------------------------------------

describe('setOriginalYear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs SET query with correct params', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    await setOriginalYear(driver, 13570466, 1974);

    const query: string = runSpy.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('SET r.originalYear');
    const params = runSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect((params['discogsId'] as { toNumber(): number }).toNumber()).toBe(13570466);
    expect((params['originalYear'] as { toNumber(): number }).toNumber()).toBe(1974);
  });

  it('closes session even when run throws', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(setOriginalYear(driver, 1, 1970)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
