import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import { searchGeneral, searchLyrics } from '../../../src/db/repositories/search-repository.js';

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
// searchGeneral
// ---------------------------------------------------------------------------

describe('searchGeneral', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps Artist nodes correctly', async () => {
    const rec = makeRecord({
      nodeLabels: ['Artist'],
      node: { properties: { name: 'John Coltrane', discogsId: makeNeo4jInt(98765) } },
      score: 3.14,
      trackReleaseTitle: null,
      trackReleaseDiscogsId: null,
      releaseArtistName: null,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await searchGeneral(driver, 'coltrane');
    expect(results).toHaveLength(1);
    const item = results[0]!;
    expect(item.type).toBe('Artist');
    if (item.type === 'Artist') {
      expect(item.name).toBe('John Coltrane');
      expect(item.discogsId).toBe(98765);
      expect(item.score).toBe(3.14);
    }
  });

  it('maps Release nodes correctly', async () => {
    const rec = makeRecord({
      nodeLabels: ['Release'],
      node: {
        properties: { title: 'A Love Supreme', discogsId: makeNeo4jInt(12345) },
      },
      score: 2.71,
      trackReleaseTitle: null,
      trackReleaseDiscogsId: null,
      releaseArtistName: 'John Coltrane',
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await searchGeneral(driver, 'love supreme');
    expect(results).toHaveLength(1);
    const item = results[0]!;
    expect(item.type).toBe('Release');
    if (item.type === 'Release') {
      expect(item.title).toBe('A Love Supreme');
      expect(item.discogsId).toBe(12345);
      expect(item.artist).toBe('John Coltrane');
      expect(item.score).toBe(2.71);
    }
  });

  it('maps Track nodes correctly', async () => {
    const rec = makeRecord({
      nodeLabels: ['Track'],
      node: { properties: { title: 'Acknowledgement' } },
      score: 1.62,
      trackReleaseTitle: 'A Love Supreme',
      trackReleaseDiscogsId: makeNeo4jInt(12345),
      releaseArtistName: null,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await searchGeneral(driver, 'acknowledgement');
    expect(results).toHaveLength(1);
    const item = results[0]!;
    expect(item.type).toBe('Track');
    if (item.type === 'Track') {
      expect(item.title).toBe('Acknowledgement');
      expect(item.releaseTitle).toBe('A Love Supreme');
      expect(item.releaseDiscogsId).toBe(12345);
      expect(item.score).toBe(1.62);
    }
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await searchGeneral(driver, 'xyznoexist');
    expect(results).toHaveLength(0);
  });

  it('skips unknown node types', async () => {
    const rec = makeRecord({
      nodeLabels: ['Studio'],
      node: { properties: { name: 'Some Studio' } },
      score: 1.0,
      trackReleaseTitle: null,
      trackReleaseDiscogsId: null,
      releaseArtistName: null,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await searchGeneral(driver, 'studio');
    expect(results).toHaveLength(0);
  });

  it('closes the session', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await searchGeneral(driver, 'test');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('passes the Lucene-escaped query as the $q parameter', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await searchGeneral(driver, '(unbalanced "');
    expect(runSpy.mock.calls[0]![1]).toEqual({ q: '\\(unbalanced \\"' });
  });

  it('short-circuits to empty without querying when input escapes to whitespace', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await searchGeneral(driver, '<>');
    expect(results).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchLyrics
// ---------------------------------------------------------------------------

describe('searchLyrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns lyrics results with release context', async () => {
    const rec = makeRecord({
      trackTitle: 'Acknowledgement',
      releaseTitle: 'A Love Supreme',
      releaseDiscogsId: makeNeo4jInt(12345),
      score: 4.2,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await searchLyrics(driver, 'supreme');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      trackTitle: 'Acknowledgement',
      releaseTitle: 'A Love Supreme',
      releaseDiscogsId: 12345,
      score: 4.2,
    });
  });

  it('returns empty array when no results', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await searchLyrics(driver, 'xyznoexist');
    expect(results).toHaveLength(0);
  });

  it('handles null release context', async () => {
    const rec = makeRecord({
      trackTitle: 'Orphaned Track',
      releaseTitle: null,
      releaseDiscogsId: null,
      score: 1.0,
    });
    const { session } = makeMockSession([makeResult([rec])]);
    const driver = makeMockDriver(session);
    const results = await searchLyrics(driver, 'orphaned');
    expect(results[0]!.releaseTitle).toBeNull();
    expect(results[0]!.releaseDiscogsId).toBeNull();
  });

  it('closes the session', async () => {
    const { session } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await searchLyrics(driver, 'test');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('passes the Lucene-escaped query as the $q parameter', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    await searchLyrics(driver, 'love*~');
    expect(runSpy.mock.calls[0]![1]).toEqual({ q: 'love\\*\\~' });
  });

  it('short-circuits to empty without querying when input escapes to whitespace', async () => {
    const { session, runSpy } = makeMockSession([makeResult([])]);
    const driver = makeMockDriver(session);
    const results = await searchLyrics(driver, '<>');
    expect(results).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });
});
