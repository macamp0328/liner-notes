import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import {
  getTracksForRecordingArtistsEnrichment,
  mergeRecordingArtistCredits,
  setRecordingArtistsFetched,
  resetRecordingArtistsEnrichment,
  type RecordingArtistCredit,
} from '../../../src/db/track-recording-artists-repository.js';
import {
  parseDisplayRole,
  parseRoleCategory,
  parseInstrument,
} from '../../../src/ingestion/transforms.js';

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
    executeWrite: vi.fn((fn: (tx: { run: typeof runSpy }) => unknown) => fn({ run: runSpy })),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

describe('getTracksForRecordingArtistsEnrichment', () => {
  it('groups candidate track element ids by recordingMbid', async () => {
    const fakeRecord = {
      get: vi.fn((key: string) => (key === 'recordingMbid' ? 'rec-1' : ['e1', 'e2'])),
    };
    const result = { records: [fakeRecord] } as unknown as Result;
    const { session } = makeMockSession(result);

    const rows = await getTracksForRecordingArtistsEnrichment(makeMockDriver(session));

    expect(rows).toEqual([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('gates on recordingMbid, the not-yet-MB-credited guard, and the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] } as unknown as Result);

    await getTracksForRecordingArtistsEnrichment(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('t.recordingMbid IS NOT NULL');
    // Already-credited Tracks must not be re-selected every staleness window.
    expect(query).toContain('NOT EXISTS {');
    expect(query).toContain("c.source = 'musicbrainz' AND c.scope = 'track'");
    expect(query).toContain('t.recordingArtistsFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('collect(elementId(t)) AS trackElementIds');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(getTracksForRecordingArtistsEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('mergeRecordingArtistCredits', () => {
  const credits: RecordingArtistCredit[] = [
    { mbid: 'mb-1', name: 'Glenn Frey', role: '12 string guitar' },
  ];

  it('resolves the person by the musicbrainzId join and writes a track-scoped MB credit', async () => {
    const { session, runSpy } = makeMockSession();

    await mergeRecordingArtistCredits(makeMockDriver(session), 'rec-1', ['e1', 'e2'], credits);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    // Deterministic MBID join — never name-matching; fallback created only ON CREATE.
    expect(query).toContain('MERGE (m:Musician {musicbrainzId: cr.mbid})');
    expect(query).toContain('ON CREATE SET m.name = cr.name');
    // Alias consolidation to a same-MBID Artist (#330/#380).
    expect(query).toContain('OPTIONAL MATCH (a:Artist {musicbrainzId: cr.mbid})');
    expect(query).toContain('MERGE (m)-[:SAME_PERSON_AS]->(a)');
    // The credit never clobbers an existing (Discogs) edge — ON CREATE only.
    expect(query).toContain('MERGE (m)-[co:CREDITED_ON]->(t)');
    expect(query).toContain('ON CREATE SET');
    expect(query).toContain("co.scope = 'track'");
    expect(query).toContain("co.source = 'musicbrainz'");
    expect(query).toContain('co.recordingMbid = $recordingMbid');
    expect(query).toContain('t.recordingArtistsFetchedAt = datetime()');
    expect(params.recordingMbid).toBe('rec-1');
    expect(params.trackElementIds).toEqual(['e1', 'e2']);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('derives displayRole / roleCategory / instrument from the role, reusing the shared transforms', async () => {
    const { session, runSpy } = makeMockSession();

    await mergeRecordingArtistCredits(makeMockDriver(session), 'rec-1', ['e1'], credits);

    const [, params] = runSpy.mock.calls[0] as [
      string,
      { credits: Array<Record<string, unknown>> },
    ];
    expect(params.credits[0]).toEqual({
      mbid: 'mb-1',
      name: 'Glenn Frey',
      role: '12 string guitar',
      displayRole: parseDisplayRole('12 string guitar'),
      roleCategory: parseRoleCategory('12 string guitar'),
      instrument: parseInstrument('12 string guitar'),
    });
    // Sanity: a guitar role really does normalize to the guitar instrument family.
    expect(params.credits[0]!.instrument).toBe('guitar');
  });

  it('buckets production credits into producer/engineer roleCategory with a null instrument (#339)', async () => {
    const { session, runSpy } = makeMockSession();
    const productionCredits: RecordingArtistCredit[] = [
      { mbid: 'mb-p', name: 'A Producer', role: 'producer' },
      { mbid: 'mb-e', name: 'An Engineer', role: 'recording engineer' },
    ];

    await mergeRecordingArtistCredits(makeMockDriver(session), 'rec-1', ['e1'], productionCredits);

    const [, params] = runSpy.mock.calls[0] as [
      string,
      { credits: Array<Record<string, unknown>> },
    ];
    expect(params.credits[0]).toMatchObject({
      role: 'producer',
      roleCategory: 'producer',
      instrument: null,
    });
    expect(params.credits[1]).toMatchObject({
      role: 'recording engineer',
      roleCategory: 'engineer',
      instrument: null,
    });
  });

  it('skips the query when there are no credits', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeRecordingArtistCredits(makeMockDriver(session), 'rec-1', ['e1'], []);
    expect(runSpy).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeRecordingArtistCredits(makeMockDriver(session), 'rec-1', [], credits);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write error'));

    await expect(
      mergeRecordingArtistCredits(makeMockDriver(session), 'rec-1', ['e1'], credits),
    ).rejects.toThrow('write error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('setRecordingArtistsFetched', () => {
  it('stamps recordingArtistsFetchedAt on the given track element ids', async () => {
    const { session, runSpy } = makeMockSession();

    await setRecordingArtistsFetched(makeMockDriver(session), ['e1']);

    const [query] = runSpy.mock.calls[0] as [string, unknown];
    expect(query).toContain('t.recordingArtistsFetchedAt = datetime()');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await setRecordingArtistsFetched(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('resetRecordingArtistsEnrichment', () => {
  it('deletes MB credits, fallback Musicians, clears markers, and returns the reset count', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue({ toNumber: () => 5 }) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [] }) // delete credits
      .mockResolvedValueOnce({ records: [] }) // delete fallback Musicians
      .mockResolvedValueOnce({ records: [resetRecord] }); // clear markers + count
    const session = {
      run: runSpy,
      executeWrite: vi.fn((fn: (tx: { run: typeof runSpy }) => unknown) => fn({ run: runSpy })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    const reset = await resetRecordingArtistsEnrichment(makeMockDriver(session));

    expect(reset).toBe(5);
    expect(session.executeWrite).toHaveBeenCalledOnce();
    expect(runSpy).toHaveBeenCalledTimes(3);
    expect((runSpy.mock.calls[0] as [string])[0]).toContain('DELETE c');
    expect((runSpy.mock.calls[1] as [string])[0]).toContain(
      'm.musicbrainzId IS NOT NULL AND m.discogsId IS NULL',
    );
    expect((runSpy.mock.calls[1] as [string])[0]).toContain('DETACH DELETE m');
    expect((runSpy.mock.calls[2] as [string])[0]).toContain('REMOVE t.recordingArtistsFetchedAt');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when no tracks had the marker', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue(undefined) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [resetRecord] });
    const session = {
      run: runSpy,
      executeWrite: vi.fn((fn: (tx: { run: typeof runSpy }) => unknown) => fn({ run: runSpy })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    expect(await resetRecordingArtistsEnrichment(makeMockDriver(session))).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('reset failed'));

    await expect(resetRecordingArtistsEnrichment(makeMockDriver(session))).rejects.toThrow(
      'reset failed',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
