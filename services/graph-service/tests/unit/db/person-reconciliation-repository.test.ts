import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session } from 'neo4j-driver';
import { reconcileSamePersonLinks } from '../../../src/db/person-reconciliation-repository.js';

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

describe('reconcileSamePersonLinks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('MERGEs SAME_PERSON_AS by shared discogsId and returns the link count', async () => {
    const { session, runSpy } = makeMockSession([
      { records: [{ get: (k: string) => (k === 'linked' ? makeNeo4jInt(42) : null) }] },
    ]);
    const count = await reconcileSamePersonLinks(makeDriver(session));
    expect(count).toBe(42);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('MATCH (a:Artist {discogsId: m.discogsId})');
    expect(query).toContain('MERGE (m)-[rel:SAME_PERSON_AS]->(a)');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when nothing reconciles', async () => {
    const { session } = makeMockSession([{ records: [] }]);
    expect(await reconcileSamePersonLinks(makeDriver(session))).toBe(0);
  });
});
