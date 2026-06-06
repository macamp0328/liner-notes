import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getVersionCandidates,
  mergeVersionRelationships,
  releasesShareArtist,
  resetTrackVersions,
} from '../../../src/db/track-versions-repository.js';

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
// Helpers — mock neo4j-driver sessions; assert on the Cypher that is sent.
// ---------------------------------------------------------------------------
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
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

function makeNeo4jRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

// ---------------------------------------------------------------------------
// getVersionCandidates
// ---------------------------------------------------------------------------
describe('getVersionCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps candidates and filters groups that only span one release', async () => {
    const crossRelease = makeNeo4jRecord({
      normalizedTitle: 'song',
      tracks: [
        { elementId: 't1', title: 'Song', releaseDiscogsId: int(10) },
        { elementId: 't2', title: 'Song (Live)', releaseDiscogsId: int(20) },
      ],
    });
    const singleRelease = makeNeo4jRecord({
      normalizedTitle: 'same-release-only',
      tracks: [
        { elementId: 't3', title: 'Same', releaseDiscogsId: int(30) },
        { elementId: 't4', title: 'Same Alt', releaseDiscogsId: int(30) },
      ],
    });
    const { session, runSpy } = makeMockSession({
      records: [crossRelease, singleRelease],
    } as unknown as Result);

    const groups = await getVersionCandidates(makeMockDriver(session));

    expect(groups).toEqual([
      {
        normalizedTitle: 'song',
        tracks: [
          { elementId: 't1', title: 'Song', releaseDiscogsId: 10 },
          { elementId: 't2', title: 'Song (Live)', releaseDiscogsId: 20 },
        ],
      },
    ]);
    expect(runSpy.mock.calls[0]?.[0]).toContain('normalizedTitle');
    expect(runSpy.mock.calls[0]?.[0]).toContain('size(tracks) > 1');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes the session even when query throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(getVersionCandidates(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// mergeVersionRelationships
// ---------------------------------------------------------------------------
describe('mergeVersionRelationships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early for an empty pair list', async () => {
    const session = makeMockSession().session;
    const driver = makeMockDriver(session);

    await mergeVersionRelationships(driver, []);

    expect(driver.session).not.toHaveBeenCalled();
  });

  it('runs one UNWIND query with mapped pair payload', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await mergeVersionRelationships(driver, [
      { fromElementId: 'a', toElementId: 'b', versionType: 'studio' },
      { fromElementId: 'c', toElementId: 'd', versionType: 'live' },
    ]);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toContain('UNWIND $pairs AS pair');
    expect(runSpy.mock.calls[0]?.[0]).toContain('IS_VERSION_OF');
    expect(runSpy.mock.calls[0]?.[1]).toEqual({
      pairs: [
        { fromId: 'a', toId: 'b', versionType: 'studio' },
        { fromId: 'c', toId: 'd', versionType: 'live' },
      ],
    });
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes the session even when query throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(
      mergeVersionRelationships(makeMockDriver(session), [
        { fromElementId: 'a', toElementId: 'b', versionType: 'studio' },
      ]),
    ).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// releasesShareArtist
// ---------------------------------------------------------------------------
describe('releasesShareArtist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when a shared artist exists and sends neo4j ints', async () => {
    const foundRecord = makeNeo4jRecord({ found: 1 });
    const { session, runSpy } = makeMockSession({ records: [foundRecord] } as unknown as Result);

    const shared = await releasesShareArtist(makeMockDriver(session), 101, 202);

    expect(shared).toBe(true);
    expect(runSpy.mock.calls[0]?.[0]).toContain('RELEASED_BY');
    const params = runSpy.mock.calls[0]?.[1] as {
      idA: { toNumber(): number };
      idB: { toNumber(): number };
    };
    expect(params.idA.toNumber()).toBe(101);
    expect(params.idB.toNumber()).toBe(202);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns false when no shared artist exists', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);

    const shared = await releasesShareArtist(makeMockDriver(session), 1, 2);

    expect(shared).toBe(false);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes the session even when query throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(releasesShareArtist(makeMockDriver(session), 1, 2)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// resetTrackVersions
// ---------------------------------------------------------------------------
describe('resetTrackVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the number of IS_VERSION_OF relationships deleted', async () => {
    const record = makeNeo4jRecord({ reset: int(18) });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);

    const reset = await resetTrackVersions(makeMockDriver(session));

    expect(reset).toBe(18);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('[r:IS_VERSION_OF]');
    expect(query).toContain('DELETE r');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when the query yields no records', async () => {
    const { session } = makeMockSession();
    const reset = await resetTrackVersions(makeMockDriver(session));
    expect(reset).toBe(0);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(resetTrackVersions(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
