import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import {
  getTracksForWorksEnrichment,
  mergeTrackWorks,
  setTrackWorksFetched,
  resetTrackWorksEnrichment,
  type WorkToMerge,
} from '../../../src/db/track-works-repository.js';

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
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

describe('getTracksForWorksEnrichment', () => {
  it('groups candidate track element ids by recordingMbid', async () => {
    const fakeRecord = {
      get: vi.fn((key: string) => (key === 'recordingMbid' ? 'rec-1' : ['e1', 'e2'])),
    };
    const result = { records: [fakeRecord] } as unknown as Result;
    const { session } = makeMockSession(result);

    const rows = await getTracksForWorksEnrichment(makeMockDriver(session));

    expect(rows).toEqual([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns empty array when no candidate tracks exist', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    expect(await getTracksForWorksEnrichment(makeMockDriver(session))).toEqual([]);
  });

  it('gates on a non-null recordingMbid and the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] } as unknown as Result);

    await getTracksForWorksEnrichment(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('t.recordingMbid IS NOT NULL');
    expect(query).toContain('t.worksFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('collect(elementId(t)) AS trackElementIds');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(getTracksForWorksEnrichment(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('mergeTrackWorks', () => {
  const works: WorkToMerge[] = [
    {
      mbid: 'work-1',
      title: 'Who Do You Love?',
      type: 'Song',
      writers: [
        { mbid: 'a-1', name: 'Bo Diddley', role: 'composer' },
        { mbid: 'a-1', name: 'Bo Diddley', role: 'lyricist' },
      ],
    },
  ];

  it('MERGEs the Work and RECORDING_OF edges and splits writers into aligned arrays', async () => {
    const { session, runSpy } = makeMockSession();

    await mergeTrackWorks(makeMockDriver(session), ['e1', 'e2'], works);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('MERGE (w:Work {mbid: work.mbid})');
    expect(query).toContain('MERGE (t)-[r:RECORDING_OF]->(w)');
    expect(query).toContain("r.source = 'musicbrainz'");
    expect(query).toContain('t.worksFetchedAt = datetime()');
    const merged = (params.works as Array<Record<string, unknown>>)[0]!;
    expect(merged.writers).toEqual(['Bo Diddley', 'Bo Diddley']);
    expect(merged.writerMbids).toEqual(['a-1', 'a-1']);
    expect(merged.writerRoles).toEqual(['composer', 'lyricist']);
    expect(params.trackElementIds).toEqual(['e1', 'e2']);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('passes empty writer arrays when a work has no writers (set is skipped in Cypher)', async () => {
    const { session, runSpy } = makeMockSession();
    const noWriters: WorkToMerge[] = [{ mbid: 'w', title: 'T', type: null, writers: [] }];

    await mergeTrackWorks(makeMockDriver(session), ['e1'], noWriters);

    const [, params] = runSpy.mock.calls[0] as [string, { works: Array<Record<string, unknown>> }];
    expect(params.works[0]!.writerMbids).toEqual([]);
  });

  it('skips the query when there are no works', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeTrackWorks(makeMockDriver(session), ['e1'], []);
    expect(runSpy).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeTrackWorks(makeMockDriver(session), [], works);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write error'));

    await expect(mergeTrackWorks(makeMockDriver(session), ['e1'], works)).rejects.toThrow(
      'write error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('setTrackWorksFetched', () => {
  it('stamps worksFetchedAt on the given track element ids', async () => {
    const { session, runSpy } = makeMockSession();

    await setTrackWorksFetched(makeMockDriver(session), ['e1']);

    const [query] = runSpy.mock.calls[0] as [string, unknown];
    expect(query).toContain('t.worksFetchedAt = datetime()');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await setTrackWorksFetched(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

    await expect(setTrackWorksFetched(makeMockDriver(session), ['e1'])).rejects.toThrow('timeout');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('resetTrackWorksEnrichment', () => {
  it('returns the reset count and deletes RECORDING_OF edges and Work nodes', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue({ toNumber: () => 7 }) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [resetRecord] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] });
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    const reset = await resetTrackWorksEnrichment(makeMockDriver(session));

    expect(reset).toBe(7);
    expect(runSpy).toHaveBeenCalledTimes(3);
    expect((runSpy.mock.calls[1] as [string])[0]).toContain('RECORDING_OF');
    expect((runSpy.mock.calls[2] as [string])[0]).toContain('MATCH (w:Work) DETACH DELETE w');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when no tracks had the marker', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue(undefined) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [resetRecord] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] });
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    expect(await resetTrackWorksEnrichment(makeMockDriver(session))).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('reset failed'));

    await expect(resetTrackWorksEnrichment(makeMockDriver(session))).rejects.toThrow(
      'reset failed',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
