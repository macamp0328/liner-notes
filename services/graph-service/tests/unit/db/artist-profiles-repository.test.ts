import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedArtists,
  setArtistProfile,
  resetArtistProfilesEnrichment,
} from '../../../src/db/artist-profiles-repository.js';

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
// getUnenrichedArtists
// ---------------------------------------------------------------------------
describe('getUnenrichedArtists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects artists still missing realName and profile, gated by the staleness window', async () => {
    const { session, runSpy } = makeMockSession();
    await getUnenrichedArtists(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('a.realName IS NULL AND a.profile IS NULL');
    expect(query).toContain('a.profileFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('NOT a.discogsId IN [194, 355]');
    expect(params).toHaveProperty('stalenessDays');
  });
});

// ---------------------------------------------------------------------------
// setArtistProfile
// ---------------------------------------------------------------------------
describe('setArtistProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps profileFetchedAt alongside realName and profile', async () => {
    const { session, runSpy } = makeMockSession();
    await setArtistProfile(makeMockDriver(session), 42, 'Real Name', 'A profile');

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('a.realName = $realName');
    expect(query).toContain('a.profile = $profile');
    expect(query).toContain('a.profileFetchedAt = datetime()');
  });
});

// ---------------------------------------------------------------------------
// resetArtistProfilesEnrichment
// ---------------------------------------------------------------------------
describe('resetArtistProfilesEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the number of artists reset and removes the marker + data', async () => {
    const record = makeNeo4jRecord({ reset: int(31) });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);

    const reset = await resetArtistProfilesEnrichment(makeMockDriver(session));

    expect(reset).toBe(31);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('a.profileFetchedAt IS NOT NULL');
    expect(query).toContain('REMOVE a.profileFetchedAt, a.realName, a.profile');
  });

  it('returns 0 when the query yields no records', async () => {
    const { session } = makeMockSession();
    const reset = await resetArtistProfilesEnrichment(makeMockDriver(session));
    expect(reset).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(resetArtistProfilesEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
