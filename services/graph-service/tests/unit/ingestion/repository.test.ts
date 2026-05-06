import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import { hasReleases, mergeReleaseGraph } from '../../../src/db/ingestion-repository.js';
import release13570466 from '../../fixtures/release-13570466.json' with { type: 'json' };
import release9999991 from '../../fixtures/release-9999991.json' with { type: 'json' };
import release9999992 from '../../fixtures/release-9999992.json' with { type: 'json' };
import type { DiscogsRelease } from '../../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Mock neo4j-driver — we want to test that the right Cypher is sent, not
// that Neo4j actually executes it.
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
// Helpers to build mock driver + session
// ---------------------------------------------------------------------------
function makeMockSession(runResult: unknown = {}): {
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
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

// ---------------------------------------------------------------------------
// hasReleases
// ---------------------------------------------------------------------------
// The query is now `MATCH (r:Release) RETURN 1 AS exists LIMIT 1` which returns one record
// when at least one Release exists, or zero records when none do. There is no "count=0 record"
// case; presence/absence of rows is the signal.
describe('hasReleases', () => {
  it('returns true when at least one Release exists (records non-empty)', async () => {
    const record = { get: vi.fn().mockReturnValue(1) } as unknown as Neo4jRecord;
    const result = { records: [record] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const result2 = await hasReleases(driver);

    expect(result2).toBe(true);
    expect(session.run).toHaveBeenCalledOnce();
  });

  it('returns false when no Release nodes exist (empty records)', async () => {
    const result = { records: [] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const result2 = await hasReleases(driver);

    expect(result2).toBe(false);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const driver = makeMockDriver(session);

    await expect(hasReleases(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// mergeReleaseGraph — verify session.run is called for each entity type
// ---------------------------------------------------------------------------
describe('mergeReleaseGraph', () => {
  let session: Session;
  let driver: Driver;

  beforeEach(() => {
    const mock = makeMockSession({ records: [] });
    session = mock.session;
    driver = makeMockDriver(session);
  });

  it('calls session.run for a full release with all entity types', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    // Should have called session.run many times (one per MERGE operation)
    expect(session.run).toHaveBeenCalled();
    const callCount = (session.run as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCount).toBeGreaterThan(5);
  });

  it('merges the Release node', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    const releaseCall = calls.find(([query]) => query.includes('MERGE (r:Release'));
    expect(releaseCall).toBeDefined();
  });

  it('merges Artist nodes and RELEASED_BY relationships', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    const artistCall = calls.find(([q]) => q.includes('MERGE (a:Artist'));
    expect(artistCall).toBeDefined();
    expect(calls.some(([q]) => q.includes('RELEASED_BY'))).toBe(true);
  });

  it('merges Label nodes and ON_LABEL relationships', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls.some(([q]) => q.includes('MERGE (l:Label'))).toBe(true);
    expect(calls.some(([q]) => q.includes('ON_LABEL'))).toBe(true);
  });

  it('merges Decade and RECORDED_IN_DECADE relationship', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls.some(([q]) => q.includes('MERGE (d:Decade'))).toBe(true);
    expect(calls.some(([q]) => q.includes('RECORDED_IN_DECADE'))).toBe(true);
  });

  it('merges Studio nodes for entity_type 23 and 27 companies', async () => {
    // release-13570466 has Bear Creek Studios as both Recorded At (23) and Mixed At (27)
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls.some(([q]) => q.includes('MERGE (s:Studio'))).toBe(true);
    expect(calls.some(([q]) => q.includes('RECORDED_AT'))).toBe(true);
  });

  it('does NOT merge studios for non-studio companies (entity_type 30, 13, 14)', async () => {
    // release-13570466 has Sterling Sound as entity_type 30 (Lacquer Cut At) — should be filtered out
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    const studioCalls = calls.filter(([q]) => q.includes('MERGE (s:Studio'));
    // Only Bear Creek Studios (23 and 27) should appear — NOT Sterling Sound (30)
    const studioParams = studioCalls.map((c) => (c[1] as { name: string }).name);
    expect(studioParams.every((name) => name === 'Bear Creek Studios')).toBe(true);
    expect(studioParams).not.toContain('Sterling Sound');
  });

  it('merges Track nodes for type_==="track" entries only', async () => {
    // release-9999991 has 2 "heading" entries and 5 tracks
    await mergeReleaseGraph(driver, release9999991 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    const trackCalls = calls.filter(([q]) => q.includes('MERGE (t:Track'));
    // Only 5 real tracks should create Track nodes (Side A and Side B headings excluded)
    expect(trackCalls).toHaveLength(5);
  });

  it('merges Musician CREDITED_ON relationships for release-level extraartists', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls.some(([q]) => q.includes('CREDITED_ON'))).toBe(true);
  });

  it('handles a release with no extraartists, no companies, no images', async () => {
    // release-9999992 has no extraartists, empty companies, empty images
    await expect(
      mergeReleaseGraph(driver, release9999992 as unknown as DiscogsRelease),
    ).resolves.toBeUndefined();
  });

  it('sets creditedAs from anv when non-empty', async () => {
    // release-13570466 has "Joe Nino-Hernes" with anv "JN-H"
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const creditedAsCalls = calls.filter(
      ([q, params]) =>
        q.includes('CREDITED_ON') &&
        params['creditedAs'] !== null &&
        params['creditedAs'] !== undefined,
    );
    expect(creditedAsCalls.length).toBeGreaterThan(0);
  });

  it('merges SAME_PERSON_AS when musician discogsId is non-zero', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [string, unknown][];
    expect(calls.some(([q]) => q.includes('SAME_PERSON_AS'))).toBe(true);
  });

  it('closes the session after all operations complete', async () => {
    await mergeReleaseGraph(driver, release9999992 as unknown as DiscogsRelease);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes the session even when a run call throws', async () => {
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Cypher error'));
    await expect(
      mergeReleaseGraph(driver, release9999992 as unknown as DiscogsRelease),
    ).rejects.toThrow('Cypher error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
