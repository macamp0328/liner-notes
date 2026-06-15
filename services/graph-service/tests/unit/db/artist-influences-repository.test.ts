import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session } from 'neo4j-driver';
import { linkInfluencedBy } from '../../../src/db/artist-influences-repository.js';

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

describe('linkInfluencedBy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('MERGEs INFLUENCED_BY by resolving each target QID against wikidataQid and returns the count', async () => {
    const { session, runSpy } = makeMockSession([
      { records: [{ get: (k: string) => (k === 'linked' ? makeNeo4jInt(8) : null) }] },
    ]);
    const count = await linkInfluencedBy(makeDriver(session));
    expect(count).toBe(8);
    const [query] = runSpy.mock.calls[0] as [string];
    // The confidence gate is the MATCH on the target's wikidataQid — an unowned QID resolves to no
    // node and is dropped (deterministic QID join, never a name match).
    expect(query).toContain('UNWIND src.influencedByQids AS targetQid');
    expect(query).toContain('MATCH (target:Artist {wikidataQid: targetQid})');
    expect(query).toContain('MERGE (src)-[rel:INFLUENCED_BY]->(target)');
    expect(query).toContain("SET rel.source = 'wikidata'");
    // Self-influence guard.
    expect(query).toContain('target <> src');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when nothing resolves to an in-collection target', async () => {
    const { session } = makeMockSession([{ records: [] }]);
    expect(await linkInfluencedBy(makeDriver(session))).toBe(0);
  });
});
