import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import { hasReleases, mergeReleaseGraph, wipeGraph } from '../../../src/db/ingestion-repository.js';
import release13570466 from '../../fixtures/release-13570466.json' with { type: 'json' };
import release9999991 from '../../fixtures/release-9999991.json' with { type: 'json' };
import release9999992 from '../../fixtures/release-9999992.json' with { type: 'json' };
import release3883522 from '../../fixtures/release-3883522.json' with { type: 'json' };
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
      // Faithful to neo4j-driver: Integer.fromValue(null/undefined) is neither number, string,
      // nor Integer, so it falls through to Integer.fromBits(value.low, ...) and throws a
      // TypeError ("Cannot read properties of null (reading 'low')"). The throw is keyed only on
      // int()'s argument — null *params* still flow through the session.run spy untouched. Without
      // this the mock would silently accept null and mask the exact crash class of issue #181.
      int: (n: number | null | undefined) => {
        if (n == null) {
          throw new TypeError(`Cannot read properties of ${String(n)} (reading 'low')`);
        }
        return { toNumber: () => n, low: n, high: 0 };
      },
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

  it('sets roleCategory on all CREDITED_ON relationships', async () => {
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const creditedOnCalls = calls.filter(([q]) => q.includes('CREDITED_ON'));
    expect(creditedOnCalls.length).toBeGreaterThan(0);
    for (const [, params] of creditedOnCalls) {
      expect(params).toHaveProperty('roleCategory');
      expect(typeof params['roleCategory']).toBe('string');
      expect((params['roleCategory'] as string).length).toBeGreaterThan(0);
    }
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

  // -------------------------------------------------------------------------
  // Issue #36 — year 0 normalization
  // -------------------------------------------------------------------------

  it('stores pressingYear as null when release.year is 0', async () => {
    const unknownYearRelease = {
      ...(release9999992 as unknown as DiscogsRelease),
      year: 0,
    };
    await mergeReleaseGraph(driver, unknownYearRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const releaseCall = calls.find(([q]) => q.includes('MERGE (r:Release'));
    expect(releaseCall).toBeDefined();
    expect(releaseCall![1]['pressingYear']).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Issue #35 — durationSeconds on Track nodes
  // -------------------------------------------------------------------------

  it('stores durationSeconds as an integer on Track nodes with parseable durations', async () => {
    // release-9999991 tracks have actual duration strings like "4:35"
    await mergeReleaseGraph(driver, release9999991 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const trackCallsWithDuration = calls.filter(
      ([q, params]) =>
        q.includes('MERGE (t:Track') &&
        params['durationSeconds'] !== null &&
        params['durationSeconds'] !== undefined,
    );
    expect(trackCallsWithDuration.length).toBeGreaterThan(0);
  });

  it('stores durationSeconds as null on Track nodes with empty duration', async () => {
    // release-13570466 tracks all have empty duration strings
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const trackCalls = calls.filter(([q]) => q.includes('MERGE (t:Track'));
    expect(trackCalls.every(([, params]) => params['durationSeconds'] === null)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Issue #37 — isVariousArtists on Release nodes
  // -------------------------------------------------------------------------

  it('sets isVariousArtists=true when primary artist id is a known VA id (194)', async () => {
    const vaRelease = {
      ...(release9999992 as unknown as DiscogsRelease),
      artists: [
        { id: 194, name: 'Various', anv: '', join: '', role: '', tracks: '', resource_url: '' },
      ],
    };
    await mergeReleaseGraph(driver, vaRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const releaseCall = calls.find(([q]) => q.includes('MERGE (r:Release'));
    expect(releaseCall![1]['isVariousArtists']).toBe(true);
  });

  it('sets isVariousArtists=true when primary artist name is "various artists"', async () => {
    const vaRelease = {
      ...(release9999992 as unknown as DiscogsRelease),
      artists: [
        {
          id: 99999,
          name: 'Various Artists',
          anv: '',
          join: '',
          role: '',
          tracks: '',
          resource_url: '',
        },
      ],
    };
    await mergeReleaseGraph(driver, vaRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const releaseCall = calls.find(([q]) => q.includes('MERGE (r:Release'));
    expect(releaseCall![1]['isVariousArtists']).toBe(true);
  });

  it('sets isVariousArtists=false for a normal release', async () => {
    // release-13570466 artist is Big Thief (id 1214695)
    await mergeReleaseGraph(driver, release13570466 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const releaseCall = calls.find(([q]) => q.includes('MERGE (r:Release'));
    expect(releaseCall![1]['isVariousArtists']).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Issue #39 — isInstrumental on Track nodes
  // -------------------------------------------------------------------------

  it('sets isInstrumental=false for regular tracks', async () => {
    // release-9999991 tracks are standard song titles with no instrumental keywords
    await mergeReleaseGraph(driver, release9999991 as unknown as DiscogsRelease);

    const calls = (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
    const trackCalls = calls.filter(([q]) => q.includes('MERGE (t:Track'));
    expect(trackCalls.every(([, params]) => params['isInstrumental'] === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #181 — a null external id must not crash (and silently drop) a release
//
// During the #165 reload, release 3883522 failed base ingestion with
// "Cannot read properties of null (reading 'low')" — neo4j.int(null) hitting an
// unguarded artist/label/credit id, dropping the whole release. The mock above is
// faithful (throws on null), so each of these tests fails on the unfixed code.
// Every variant is a structuredClone of the real captured 3883522 payload.
// ---------------------------------------------------------------------------
describe('mergeReleaseGraph — null/0 external ids (issue #181)', () => {
  let session: Session;
  let driver: Driver;

  beforeEach(() => {
    const mock = makeMockSession({ records: [] });
    session = mock.session;
    driver = makeMockDriver(session);
  });

  function runCalls(): [string, Record<string, unknown>][] {
    return (session.run as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      Record<string, unknown>,
    ][];
  }

  it('ingests the real 3883522 payload (all valid ids) without throwing', async () => {
    await expect(
      mergeReleaseGraph(driver, release3883522 as unknown as DiscogsRelease),
    ).resolves.toBeUndefined();

    const calls = runCalls();
    expect(calls.some(([q]) => q.includes('MERGE (r:Release'))).toBe(true);
    expect(calls.some(([q]) => q.includes('MERGE (a:Artist'))).toBe(true);
    expect(calls.some(([q]) => q.includes('CREDITED_ON'))).toBe(true);
  });

  it('throws a legible error (not a cryptic null.low) when release.id is null', async () => {
    const noId = structuredClone(release3883522) as unknown as DiscogsRelease;
    (noId as unknown as { id: number | null }).id = null;

    await expect(mergeReleaseGraph(driver, noId)).rejects.toThrow(/no id/i);
    // The guard runs before the session opens, so nothing is written.
    expect(session.run).not.toHaveBeenCalled();
  });

  it('routes null-id and 0-id extraartists to name-only credits instead of crashing', async () => {
    const r = structuredClone(release3883522) as unknown as DiscogsRelease;
    r.extraartists![0]!.id = null; // the issue #181 shape
    r.extraartists![1]!.id = 0; // Discogs "uncatalogued person"
    const nullName = r.extraartists![0]!.name;
    const zeroName = r.extraartists![1]!.name;

    await expect(mergeReleaseGraph(driver, r)).resolves.toBeUndefined();

    const nameOnly = runCalls().filter(([q]) => q.includes('MERGE (m:Musician {name: $name})'));
    const byId = runCalls().filter(([q]) => q.includes('MERGE (m:Musician {discogsId'));
    // Both the null-id and the 0-id credit became name-only Musician nodes (no discogsId param)...
    expect(nameOnly.some(([, p]) => p['name'] === nullName && p['discogsId'] === undefined)).toBe(
      true,
    );
    expect(nameOnly.some(([, p]) => p['name'] === zeroName)).toBe(true);
    // ...while the remaining valid-id credits still merged by discogsId.
    expect(byId.length).toBeGreaterThan(0);
  });

  it('skips a primary artist with a null id and still ingests the release', async () => {
    const r = structuredClone(release3883522) as unknown as DiscogsRelease;
    r.artists[0]!.id = null;

    await expect(mergeReleaseGraph(driver, r)).resolves.toBeUndefined();
    // 3883522 has a single artist; nulling its id leaves no Artist node to merge.
    expect(runCalls().some(([q]) => q.includes('MERGE (a:Artist'))).toBe(false);
  });

  it('skips a primary artist with id 0 the same way', async () => {
    const r = structuredClone(release3883522) as unknown as DiscogsRelease;
    r.artists[0]!.id = 0;

    await expect(mergeReleaseGraph(driver, r)).resolves.toBeUndefined();
    expect(runCalls().some(([q]) => q.includes('MERGE (a:Artist'))).toBe(false);
  });

  it('skips a null-id label while still merging the other valid label', async () => {
    const r = structuredClone(release3883522) as unknown as DiscogsRelease;
    const survivingLabel = r.labels[1]!.name; // 3883522 has two labels
    r.labels[0]!.id = null;

    await expect(mergeReleaseGraph(driver, r)).resolves.toBeUndefined();

    const labelCalls = runCalls().filter(([q]) => q.includes('MERGE (l:Label'));
    expect(labelCalls).toHaveLength(1);
    expect((labelCalls[0]![1] as { name: string }).name).toBe(survivingLabel);
  });

  it('skips an id-0 label the same way', async () => {
    const r = structuredClone(release3883522) as unknown as DiscogsRelease;
    r.labels[0]!.id = 0;

    await expect(mergeReleaseGraph(driver, r)).resolves.toBeUndefined();
    expect(runCalls().filter(([q]) => q.includes('MERGE (l:Label'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// wipeGraph — DETACH DELETE everything, return the deleted-node count
// ---------------------------------------------------------------------------
describe('wipeGraph', () => {
  it('runs DETACH DELETE and returns the deleted-node count', async () => {
    const record = {
      get: vi.fn().mockReturnValue({ toNumber: () => 4217 }),
    } as unknown as Neo4jRecord;
    const result = { records: [record] } as unknown as Result;
    const { session, runSpy } = makeMockSession(result);

    const deleted = await wipeGraph(makeMockDriver(session));

    expect(deleted).toBe(4217);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('DETACH DELETE');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 on an already-empty graph (no record / null count)', async () => {
    const result = { records: [] } as unknown as Result;
    const { session } = makeMockSession(result);

    expect(await wipeGraph(makeMockDriver(session))).toBe(0);
  });
});
