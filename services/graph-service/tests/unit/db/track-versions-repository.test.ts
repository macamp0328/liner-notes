import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import { resetTrackVersions } from '../../../src/db/track-versions-repository.js';

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
  });

  it('returns 0 when the query yields no records', async () => {
    const { session } = makeMockSession();
    const reset = await resetTrackVersions(makeMockDriver(session));
    expect(reset).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(resetTrackVersions(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
