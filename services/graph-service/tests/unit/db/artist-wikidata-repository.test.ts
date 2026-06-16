import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedArtistsForWikidata,
  setArtistWikidata,
  resetArtistWikidataEnrichment,
} from '../../../src/db/artist-wikidata-repository.js';
import type { ArtistWikidataData } from '../../../src/ingestion/wikidata-client.js';

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

const FULL_DATA: ArtistWikidataData = {
  qid: 'Q1299',
  bornYear: 1941,
  bornDate: '1941-10-13',
  diedYear: null,
  diedDate: null,
  imageUrl: 'http://commons.wikimedia.org/wiki/Special:FilePath/Paul.jpg',
  awards: ['Grammy Award'],
  playsInstrument: ['guitar', 'vocals'],
  playsInstrumentRaw: ['guitar', 'vocals'],
  influencedByQids: ['Q5383', 'Q1124'],
  memberOfQids: ['Q1299', 'Q622988'],
  memberOfSinceYears: [1960, 1971],
  memberOfUntilYears: [1970, 0],
};

describe('getUnenrichedArtistsForWikidata', () => {
  it('returns mapped artists from query results', async () => {
    const record = makeRecord({ discogsId: makeNeo4jInt(42), name: 'Paul Simon' });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedArtistsForWikidata(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: 42, name: 'Paul Simon' }]);
    expect(session.close).toHaveBeenCalled();
  });

  it('gates on a missing QID + staleness window, excluding the Various-Artists placeholders', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });

    await getUnenrichedArtistsForWikidata(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('a.wikidataQid IS NULL');
    expect(query).toContain('a.wikidataFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('NOT a.discogsId IN [194, 355]');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session even when the query throws', async () => {
    const runSpy = vi.fn().mockRejectedValue(new Error('DB error'));
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    await expect(getUnenrichedArtistsForWikidata(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalled();
  });
});

describe('setArtistWikidata', () => {
  it('writes every Wikidata property plus the stamp when data is present', async () => {
    const { session, runSpy } = makeMockSession();

    await setArtistWikidata(makeMockDriver(session), 42, FULL_DATA);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('a.wikidataQid = $qid');
    expect(query).toContain('a.bornYear = $bornYear');
    expect(query).toContain('a.awards = $awards');
    expect(query).toContain('a.playsInstrument = $playsInstrument');
    expect(query).toContain('a.playsInstrumentRaw = $playsInstrumentRaw');
    expect(query).toContain('a.influencedByQids = $influencedByQids');
    expect(query).toContain('a.memberOfQids = $memberOfQids');
    expect(query).toContain('a.memberOfSinceYears = $memberOfSinceYears');
    expect(query).toContain('a.memberOfUntilYears = $memberOfUntilYears');
    expect(query).toContain('a.wikidataFetchedAt = datetime()');
    expect(params).toMatchObject({
      qid: 'Q1299',
      bornDate: '1941-10-13',
      awards: ['Grammy Award'],
      playsInstrument: ['guitar', 'vocals'],
      playsInstrumentRaw: ['guitar', 'vocals'],
      influencedByQids: ['Q5383', 'Q1124'],
      memberOfQids: ['Q1299', 'Q622988'],
    });
    // Year arrays are wrapped per-element in neo4j.int (so the band-membership pass can index +
    // compare the 0 sentinel) — assert the unwrapped values rather than the Integer objects.
    const params2 = runSpy.mock.calls[0]?.[1] as {
      memberOfSinceYears: { toNumber(): number }[];
      memberOfUntilYears: { toNumber(): number }[];
    };
    expect(params2.memberOfSinceYears.map((y) => y.toNumber())).toEqual([1960, 1971]);
    expect(params2.memberOfUntilYears.map((y) => y.toNumber())).toEqual([1970, 0]);
    expect(session.close).toHaveBeenCalled();
  });

  it('only stamps wikidataFetchedAt when data is null (markAttempted path)', async () => {
    const { session, runSpy } = makeMockSession();

    await setArtistWikidata(makeMockDriver(session), 42, null);

    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).not.toContain('a.wikidataQid = $qid');
    expect(query).toContain('a.wikidataFetchedAt = datetime()');
  });
});

describe('resetArtistWikidataEnrichment', () => {
  it('removes the marker and every Wikidata property, returning the count', async () => {
    const record = makeRecord({ reset: makeNeo4jInt(7) });
    const { session, runSpy } = makeMockSession({ records: [record] });

    const count = await resetArtistWikidataEnrichment(makeMockDriver(session));

    expect(count).toBe(7);
    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).toContain('REMOVE a.wikidataFetchedAt');
    expect(query).toContain('a.wikidataQid');
    expect(query).toContain('a.awards');
    expect(query).toContain('a.playsInstrument');
    expect(query).toContain('a.playsInstrumentRaw');
    expect(query).toContain('a.influencedByQids');
    expect(query).toContain('a.memberOfQids');
    expect(query).toContain('a.memberOfSinceYears');
    expect(query).toContain('a.memberOfUntilYears');
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] });
    expect(await resetArtistWikidataEnrichment(makeMockDriver(session))).toBe(0);
  });
});
