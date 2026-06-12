import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedArtistsForNationality,
  getUnenrichedMusiciansForNationality,
  setArtistNationality,
  setMusicianNationality,
  resetNationalityEnrichment,
} from '../../../src/db/artist-nationality-repository.js';

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
// getUnenrichedArtistsForNationality
// ---------------------------------------------------------------------------
describe('getUnenrichedArtistsForNationality', () => {
  it('returns mapped artists from query results', async () => {
    const record = makeRecord({ discogsId: makeNeo4jInt(42), name: 'Miles Davis' });
    const { session } = makeMockSession({ records: [record] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedArtistsForNationality(driver);

    expect(result).toEqual([{ discogsId: 42, name: 'Miles Davis' }]);
    expect(session.close).toHaveBeenCalled();
  });

  it('selects artists with no ORIGIN_COUNTRY, gated by the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });

    await getUnenrichedArtistsForNationality(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('NOT EXISTS { (a)-[:ORIGIN_COUNTRY]->() }');
    expect(query).toContain('a.nationalityFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('NOT a.discogsId IN [194, 355]');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('returns empty array when no unenriched artists', async () => {
    const { session } = makeMockSession({ records: [] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedArtistsForNationality(driver);

    expect(result).toEqual([]);
  });

  it('closes session even when query throws', async () => {
    const runSpy = vi.fn().mockRejectedValue(new Error('DB error'));
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    await expect(getUnenrichedArtistsForNationality(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getUnenrichedMusiciansForNationality
// ---------------------------------------------------------------------------
describe('getUnenrichedMusiciansForNationality', () => {
  it('returns musician with discogsId', async () => {
    const record = makeRecord({ discogsId: makeNeo4jInt(10), name: 'Ron Carter' });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedMusiciansForNationality(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: 10, name: 'Ron Carter' }]);
  });

  it('returns musician with null discogsId', async () => {
    const record = makeRecord({ discogsId: null, name: 'Session Player' });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedMusiciansForNationality(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: null, name: 'Session Player' }]);
  });

  it('queries the Musician label', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });

    await getUnenrichedMusiciansForNationality(makeMockDriver(session));

    expect(runSpy.mock.calls[0]?.[0]).toContain('Musician');
  });
});

// ---------------------------------------------------------------------------
// setArtistNationality
// ---------------------------------------------------------------------------
describe('setArtistNationality', () => {
  it('merges ORIGIN_COUNTRY tagged with the resolving source', async () => {
    const { session, runSpy } = makeMockSession();
    await setArtistNationality(makeMockDriver(session), 42, 'US', 'musicbrainz');

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toContain('MERGE (c:Country');
    expect(runSpy.mock.calls[0]?.[0]).toContain('SET rel.source = $source');
    expect(runSpy.mock.calls[0]?.[1]).toMatchObject({ countryCode: 'US', source: 'musicbrainz' });
    expect(session.close).toHaveBeenCalled();
  });

  it('only stamps nationalityFetchedAt when countryCode is null', async () => {
    const { session, runSpy } = makeMockSession();
    await setArtistNationality(makeMockDriver(session), 42, null, null);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).not.toContain('MERGE (c:Country');
    expect(runSpy.mock.calls[0]?.[0]).not.toContain('rel.source');
    expect(runSpy.mock.calls[0]?.[0]).toContain('nationalityFetchedAt = datetime()');
  });
});

// ---------------------------------------------------------------------------
// setMusicianNationality
// ---------------------------------------------------------------------------
describe('setMusicianNationality', () => {
  it('matches by discogsId when present and tags the source', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: 10, name: 'Ron Carter' },
      'US',
      'wikidata',
    );

    expect(runSpy.mock.calls[0]?.[0]).toContain('discogsId: $discogsId');
    expect(runSpy.mock.calls[0]?.[0]).toContain('SET rel.source = $source');
    expect(runSpy.mock.calls[0]?.[1]).toMatchObject({ source: 'wikidata' });
  });

  it('matches by name when discogsId is null', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: null, name: 'Anon' },
      'FR',
      'wikidata',
    );

    expect(runSpy.mock.calls[0]?.[0]).toContain('name: $name');
    expect(runSpy.mock.calls[0]?.[0]).toContain('m.discogsId IS NULL');
  });

  it('sets null country without merging Country node', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: 10, name: 'Someone' },
      null,
      null,
    );

    expect(runSpy.mock.calls[0]?.[0]).not.toContain('MERGE (c:Country');
  });
});

// ---------------------------------------------------------------------------
// resetNationalityEnrichment
// ---------------------------------------------------------------------------
describe('resetNationalityEnrichment', () => {
  it('returns the count of reset nodes', async () => {
    const record = makeRecord({ reset: makeNeo4jInt(12) });
    const { session } = makeMockSession({ records: [record] });

    const count = await resetNationalityEnrichment(makeMockDriver(session));

    expect(count).toBe(12);
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] });

    const count = await resetNationalityEnrichment(makeMockDriver(session));

    expect(count).toBe(0);
  });

  it('resets Artist and Musician nodes', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });

    await resetNationalityEnrichment(makeMockDriver(session));

    expect(runSpy.mock.calls[0]?.[0]).toContain('n:Artist');
    expect(runSpy.mock.calls[0]?.[0]).toContain('n:Musician');
    expect(runSpy.mock.calls[0]?.[0]).not.toContain('n:Producer');
    expect(runSpy.mock.calls[0]?.[0]).not.toContain('n:Engineer');
  });
});
