import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedLabels,
  setLabelParent,
  setLabelHierarchyFetched,
  resetLabelHierarchyEnrichment,
} from '../../../src/db/label-hierarchy-repository.js';

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
// getUnenrichedLabels
// ---------------------------------------------------------------------------
describe('getUnenrichedLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects collection labels gated by the staleness window', async () => {
    const { session, runSpy } = makeMockSession();
    await getUnenrichedLabels(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('EXISTS { (l)<-[:ON_LABEL]-(:Release) }');
    expect(query).toContain('l.labelHierarchyFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('maps discogsId off the returned records', async () => {
    const record = makeNeo4jRecord({ discogsId: int(634) });
    const { session } = makeMockSession({ records: [record] } as unknown as Result);
    const labels = await getUnenrichedLabels(makeMockDriver(session));
    expect(labels).toEqual([{ discogsId: 634 }]);
  });
});

// ---------------------------------------------------------------------------
// setLabelParent
// ---------------------------------------------------------------------------
describe('setLabelParent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconciles the single parent edge and stamps the marker', async () => {
    const { session, runSpy } = makeMockSession();
    await setLabelParent(makeMockDriver(session), 634, { discogsId: 123, name: 'Beggars Group' });

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    // deletes any existing parent edge before merging the new one
    expect(query).toContain('OPTIONAL MATCH (child)-[old:PARENT_LABEL]->(:Label)');
    expect(query).toContain('DELETE old');
    expect(query).toContain('MERGE (parent:Label {discogsId: $parentId})');
    expect(query).toContain('MERGE (child)-[:PARENT_LABEL]->(parent)');
    expect(query).toContain('child.labelHierarchyFetchedAt = datetime()');
    expect(params).toMatchObject({ parentName: 'Beggars Group' });
  });
});

// ---------------------------------------------------------------------------
// setLabelHierarchyFetched (markAttempted — no parent)
// ---------------------------------------------------------------------------
describe('setLabelHierarchyFetched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes any stale parent edge and stamps the marker', async () => {
    const { session, runSpy } = makeMockSession();
    await setLabelHierarchyFetched(makeMockDriver(session), 634);

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('OPTIONAL MATCH (child)-[old:PARENT_LABEL]->(:Label)');
    expect(query).toContain('DELETE old');
    expect(query).toContain('child.labelHierarchyFetchedAt = datetime()');
    expect(query).not.toContain('MERGE (parent');
  });
});

// ---------------------------------------------------------------------------
// resetLabelHierarchyEnrichment
// ---------------------------------------------------------------------------
describe('resetLabelHierarchyEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the count and removes the marker + PARENT_LABEL edges', async () => {
    const record = makeNeo4jRecord({ reset: int(12) });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);

    const reset = await resetLabelHierarchyEnrichment(makeMockDriver(session));

    expect(reset).toBe(12);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('l.labelHierarchyFetchedAt IS NOT NULL');
    expect(query).toContain('REMOVE l.labelHierarchyFetchedAt');
    expect(query).toContain('[p:PARENT_LABEL]');
    expect(query).toContain('DELETE p');
  });

  it('returns 0 when the query yields no records', async () => {
    const { session } = makeMockSession();
    const reset = await resetLabelHierarchyEnrichment(makeMockDriver(session));
    expect(reset).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(resetLabelHierarchyEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
