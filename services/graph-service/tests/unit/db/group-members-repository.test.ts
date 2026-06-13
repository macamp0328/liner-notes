import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session } from 'neo4j-driver';
import {
  getGroupCandidates,
  setGroupMembers,
  stampMembersFetched,
  resetGroupMembers,
} from '../../../src/db/group-members-repository.js';

vi.mock('neo4j-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('neo4j-driver')>();
  return {
    ...actual,
    default: { ...actual.default, int: (n: number) => ({ toNumber: () => n, low: n, high: 0 }) },
  };
});

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

describe('getGroupCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns Musician discogsIds and closes the session', async () => {
    const { session, runSpy } = makeMockSession([
      {
        records: [
          { get: (k: string) => (k === 'discogsId' ? makeNeo4jInt(101) : null) },
          { get: (k: string) => (k === 'discogsId' ? makeNeo4jInt(202) : null) },
        ],
      },
    ]);
    const result = await getGroupCandidates(makeDriver(session));
    expect(result).toEqual([{ discogsId: 101 }, { discogsId: 202 }]);
    const [query] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('m.discogsId IS NOT NULL');
    expect(query).toContain('membersFetchedAt');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('setGroupMembers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the group id and member rows (id mapped to neo4j int, active preserved)', async () => {
    const { session, runSpy } = makeMockSession();
    await setGroupMembers(makeDriver(session), 900, [
      { id: 11, active: true },
      { id: 22, active: false },
    ]);
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('MERGE (m)-[rel:MEMBER_OF]->(group)');
    expect(query).toContain('SET group.membersFetchedAt = datetime()');
    expect((params['groupDiscogsId'] as { toNumber(): number }).toNumber()).toBe(900);
    const members = params['members'] as Array<{ id: { toNumber(): number }; active: boolean }>;
    expect(members.map((m) => ({ id: m.id.toNumber(), active: m.active }))).toEqual([
      { id: 11, active: true },
      { id: 22, active: false },
    ]);
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('stampMembersFetched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps membersFetchedAt without writing edges', async () => {
    const { session, runSpy } = makeMockSession();
    await stampMembersFetched(makeDriver(session), 555);
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('SET m.membersFetchedAt = datetime()');
    expect(query).not.toContain('MEMBER_OF');
    expect((params['discogsId'] as { toNumber(): number }).toNumber()).toBe(555);
  });
});

describe('resetGroupMembers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes MEMBER_OF edges, clears markers, and returns the cleared count', async () => {
    const { session, runSpy } = makeMockSession([
      { records: [] },
      { records: [{ get: (k: string) => (k === 'reset' ? makeNeo4jInt(4) : null) }] },
    ]);
    const count = await resetGroupMembers(makeDriver(session));
    expect(count).toBe(4);
    const [deleteQuery] = runSpy.mock.calls[0] as [string];
    expect(deleteQuery).toContain('DELETE r');
    const [clearQuery] = runSpy.mock.calls[1] as [string];
    expect(clearQuery).toContain('REMOVE m.membersFetchedAt');
  });

  it('returns 0 when no markers exist', async () => {
    const { session } = makeMockSession([{ records: [] }, { records: [] }]);
    expect(await resetGroupMembers(makeDriver(session))).toBe(0);
  });
});
