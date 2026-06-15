import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedArtistsForMbid,
  getUnenrichedMusiciansForMbid,
  setArtistMusicbrainzId,
  setMusicianMusicbrainzId,
  resetMusicbrainzIdEnrichment,
} from '../../../src/db/artist-musicbrainz-id-repository.js';

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
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

function makeNeo4jInt(n: number) {
  return { toNumber: () => n, low: n, high: 0 };
}

// ---------------------------------------------------------------------------
// getUnenrichedArtistsForMbid
// ---------------------------------------------------------------------------
describe('getUnenrichedArtistsForMbid', () => {
  it('returns mapped artists from query results', async () => {
    const record = makeRecord({ discogsId: makeNeo4jInt(42), name: 'Miles Davis' });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedArtistsForMbid(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: 42, name: 'Miles Davis' }]);
    expect(session.close).toHaveBeenCalled();
  });

  it('selects artists missing musicbrainzId, gated by the staleness window, excluding VA', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });

    await getUnenrichedArtistsForMbid(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('a.musicbrainzId IS NULL');
    expect(query).toContain('a.discogsId IS NOT NULL');
    expect(query).toContain('a.musicbrainzIdFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('NOT a.discogsId IN [194, 355]');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes session even when query throws', async () => {
    const runSpy = vi.fn().mockRejectedValue(new Error('DB error'));
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    await expect(getUnenrichedArtistsForMbid(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getUnenrichedMusiciansForMbid
// ---------------------------------------------------------------------------
describe('getUnenrichedMusiciansForMbid', () => {
  it('returns mapped musicians and requires a discogsId (excludes name-only)', async () => {
    const record = makeRecord({ discogsId: makeNeo4jInt(10), name: 'Ron Carter' });
    const { session, runSpy } = makeMockSession({ records: [record] });

    const result = await getUnenrichedMusiciansForMbid(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: 10, name: 'Ron Carter' }]);
    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).toContain('MATCH (m:Musician)');
    expect(query).toContain('m.discogsId IS NOT NULL');
    expect(query).toContain('m.musicbrainzId IS NULL');
  });
});

// ---------------------------------------------------------------------------
// setArtistMusicbrainzId
// ---------------------------------------------------------------------------
describe('setArtistMusicbrainzId', () => {
  it('sets musicbrainzId and stamps the marker when an mbid is found', async () => {
    const { session, runSpy } = makeMockSession();
    await setArtistMusicbrainzId(makeMockDriver(session), 42, 'mb-uuid');

    expect(runSpy).toHaveBeenCalledTimes(1);
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('SET a.musicbrainzId = $mbid');
    expect(query).toContain('a.musicbrainzIdFetchedAt = datetime()');
    expect(params).toMatchObject({ mbid: 'mb-uuid' });
    expect(session.close).toHaveBeenCalled();
  });

  it('only stamps the marker when mbid is null (throttled retry)', async () => {
    const { session, runSpy } = makeMockSession();
    await setArtistMusicbrainzId(makeMockDriver(session), 42, null);

    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).not.toContain('a.musicbrainzId = $mbid');
    expect(query).toContain('a.musicbrainzIdFetchedAt = datetime()');
  });
});

// ---------------------------------------------------------------------------
// setMusicianMusicbrainzId
// ---------------------------------------------------------------------------
describe('setMusicianMusicbrainzId', () => {
  it('matches by discogsId and sets musicbrainzId when found', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianMusicbrainzId(makeMockDriver(session), 10, 'mb-uuid');

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('MATCH (m:Musician {discogsId: $discogsId})');
    expect(query).toContain('SET m.musicbrainzId = $mbid');
    expect(params).toMatchObject({ mbid: 'mb-uuid' });
  });

  it('only stamps the marker when mbid is null', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianMusicbrainzId(makeMockDriver(session), 10, null);

    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).not.toContain('m.musicbrainzId = $mbid');
    expect(query).toContain('m.musicbrainzIdFetchedAt = datetime()');
  });
});

// ---------------------------------------------------------------------------
// resetMusicbrainzIdEnrichment
// ---------------------------------------------------------------------------
describe('resetMusicbrainzIdEnrichment', () => {
  it('removes both markers from Artist and Musician nodes and returns the count', async () => {
    const record = makeRecord({ reset: makeNeo4jInt(7) });
    const { session, runSpy } = makeMockSession({ records: [record] });

    const count = await resetMusicbrainzIdEnrichment(makeMockDriver(session));

    expect(count).toBe(7);
    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).toContain('n:Artist');
    expect(query).toContain('n:Musician');
    expect(query).toContain('REMOVE n.musicbrainzId, n.musicbrainzIdFetchedAt');
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] });
    expect(await resetMusicbrainzIdEnrichment(makeMockDriver(session))).toBe(0);
  });
});
