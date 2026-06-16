import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session } from 'neo4j-driver';
import { linkBandMemberships } from '../../../src/db/band-membership-repository.js';

function makeNeo4jInt(n: number) {
  return { toNumber: () => n, low: n, high: 0 };
}

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

function makeDriver(session: Session): Driver {
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

describe('linkBandMemberships', () => {
  beforeEach(() => vi.clearAllMocks());

  it('MERGEs dated MEMBER_OF edges by resolving each group QID against wikidataQid and returns the count', async () => {
    const { session, runSpy } = makeMockSession([
      { records: [{ get: (k: string) => (k === 'linked' ? makeNeo4jInt(5) : null) }] },
    ]);
    const count = await linkBandMemberships(makeDriver(session));
    expect(count).toBe(5);
    const [query] = runSpy.mock.calls[0] as [string];
    // Index-aligned unzip of the three memberOf* arrays.
    expect(query).toContain('UNWIND range(0, size(src.memberOfQids) - 1) AS i');
    // The confidence gate is the MATCH on the group's wikidataQid — an unowned QID resolves to no
    // node and is dropped (deterministic QID join, never a name match).
    expect(query).toContain('MATCH (grp:Artist {wikidataQid: groupQid})');
    // Provenance-tagged edge, distinct from the Discogs Musician→Musician MEMBER_OF.
    expect(query).toContain("MERGE (src)-[rel:MEMBER_OF {source: 'wikidata'}]->(grp)");
    // The 0 sentinel (no Wikidata qualifier) leaves the edge date-less.
    expect(query).toContain('CASE WHEN sinceYear = 0 THEN null ELSE sinceYear END');
    expect(query).toContain('CASE WHEN untilYear = 0 THEN null ELSE untilYear END');
    // Self-membership guard.
    expect(query).toContain('grp <> src');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when nothing resolves to an in-collection group', async () => {
    const { session } = makeMockSession([{ records: [] }]);
    expect(await linkBandMemberships(makeDriver(session))).toBe(0);
  });
});
