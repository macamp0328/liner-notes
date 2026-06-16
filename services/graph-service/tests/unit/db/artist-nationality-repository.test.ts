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
  it('returns mapped artists from query results, carrying any stored musicbrainzId (#380)', async () => {
    const record = makeRecord({
      discogsId: makeNeo4jInt(42),
      name: 'Miles Davis',
      musicbrainzId: 'mb-42',
    });
    const { session, runSpy } = makeMockSession({ records: [record] });
    const driver = makeMockDriver(session);

    const result = await getUnenrichedArtistsForNationality(driver);

    expect(result).toEqual([{ discogsId: 42, name: 'Miles Davis', musicbrainzId: 'mb-42' }]);
    expect(runSpy.mock.calls[0]?.[0]).toContain('a.musicbrainzId AS musicbrainzId');
    expect(session.close).toHaveBeenCalled();
  });

  it('maps a missing musicbrainzId to null', async () => {
    const record = makeRecord({ discogsId: makeNeo4jInt(43), name: 'No MBID' });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedArtistsForNationality(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: 43, name: 'No MBID', musicbrainzId: null }]);
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
  it('returns musician with discogsId and stored musicbrainzId', async () => {
    const record = makeRecord({
      discogsId: makeNeo4jInt(10),
      name: 'Ron Carter',
      musicbrainzId: 'mb-10',
    });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedMusiciansForNationality(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: 10, name: 'Ron Carter', musicbrainzId: 'mb-10' }]);
  });

  it('returns musician with null discogsId and null musicbrainzId', async () => {
    const record = makeRecord({ discogsId: null, name: 'Session Player' });
    const { session } = makeMockSession({ records: [record] });

    const result = await getUnenrichedMusiciansForNationality(makeMockDriver(session));

    expect(result).toEqual([{ discogsId: null, name: 'Session Player', musicbrainzId: null }]);
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
      { discogsId: 10, name: 'Ron Carter', musicbrainzId: null },
      'US',
      'wikidata',
    );

    expect(runSpy.mock.calls[0]?.[0]).toContain('discogsId: $discogsId');
    expect(runSpy.mock.calls[0]?.[0]).toContain('SET rel.source = $source');
    expect(runSpy.mock.calls[0]?.[1]).toMatchObject({ source: 'wikidata' });
  });

  // #426: a no-discogsId node carrying a musicbrainzId is matched by that unique key,
  // not by name — so the write can never spill onto a same-named, distinct-MBID node.
  it('matches by musicbrainzId when discogsId is null and an MBID is present (#426)', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: null, name: 'John Williams', musicbrainzId: 'mb-uuid' },
      'US',
      'musicbrainz',
    );

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('musicbrainzId: $musicbrainzId');
    expect(query).not.toContain('name: $name');
    // The MBID arm carries the same discogsId-null guard as the name arm: musicbrainzId is
    // not uniqueness-constrained, so the guard keeps the write off a colliding discogsId node.
    expect(query).toContain('m.discogsId IS NULL');
    expect(params).toMatchObject({ musicbrainzId: 'mb-uuid' });
  });

  // The null-country (markAttempted) path shares the same match clause, so the MBID key
  // also keeps the nationalityFetchedAt stamp from contaminating same-named nodes (#426).
  it('matches by musicbrainzId on the null-country path too (#426)', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: null, name: 'John Williams', musicbrainzId: 'mb-uuid' },
      null,
      null,
    );

    const query = runSpy.mock.calls[0]?.[0] as string;
    expect(query).toContain('musicbrainzId: $musicbrainzId');
    expect(query).not.toContain('MERGE (c:Country');
    expect(query).toContain('nationalityFetchedAt = datetime()');
  });

  // Truthy check (not `!== null`): an empty-string MBID falls through to the name path,
  // mirroring the caller's resolve-side predicate.
  it('falls through to name match when musicbrainzId is an empty string', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: null, name: 'Anon', musicbrainzId: '' },
      'FR',
      'wikidata',
    );

    expect(runSpy.mock.calls[0]?.[0]).toContain('name: $name');
    expect(runSpy.mock.calls[0]?.[0]).toContain('m.discogsId IS NULL');
  });

  it('matches by name when discogsId and musicbrainzId are both null', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: null, name: 'Anon', musicbrainzId: null },
      'FR',
      'wikidata',
    );

    expect(runSpy.mock.calls[0]?.[0]).toContain('name: $name');
    expect(runSpy.mock.calls[0]?.[0]).toContain('m.discogsId IS NULL');
  });

  // discogsId wins over a present MBID — the discogsId arm is evaluated first.
  it('prefers discogsId over musicbrainzId when both are present', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: 5, name: 'Ron Carter', musicbrainzId: 'mb-uuid' },
      'US',
      'wikidata',
    );

    expect(runSpy.mock.calls[0]?.[0]).toContain('discogsId: $discogsId');
    expect(runSpy.mock.calls[0]?.[0]).not.toContain('musicbrainzId: $musicbrainzId');
  });

  it('sets null country without merging Country node', async () => {
    const { session, runSpy } = makeMockSession();
    await setMusicianNationality(
      makeMockDriver(session),
      { discogsId: 10, name: 'Someone', musicbrainzId: null },
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
