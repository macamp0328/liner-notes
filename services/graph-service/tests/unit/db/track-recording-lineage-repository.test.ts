import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import {
  getTracksForRecordingLineageEnrichment,
  mergeRecordingLineage,
  setRecordingLineageFetched,
  resetRecordingLineageEnrichment,
} from '../../../src/db/track-recording-lineage-repository.js';
import type { MbRecordingDerivation } from '../../../src/ingestion/musicbrainz-client.js';

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

describe('getTracksForRecordingLineageEnrichment', () => {
  it('groups candidate track element ids by recordingMbid', async () => {
    const fakeRecord = {
      get: vi.fn((key: string) => (key === 'recordingMbid' ? 'rec-1' : ['e1', 'e2'])),
    };
    const result = { records: [fakeRecord] } as unknown as Result;
    const { session } = makeMockSession(result);

    const rows = await getTracksForRecordingLineageEnrichment(makeMockDriver(session));

    expect(rows).toEqual([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('gates on recordingMbid, a source-scoped not-yet-linked guard, and the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] } as unknown as Result);

    await getTracksForRecordingLineageEnrichment(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('t.recordingMbid IS NOT NULL');
    expect(query).toContain('NOT EXISTS {');
    expect(query).toContain('(t)-[r:RELATED_RECORDING]->(:Recording)');
    expect(query).toContain("r.source = 'musicbrainz'");
    expect(query).toContain('t.recordingLineageFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('collect(elementId(t)) AS trackElementIds');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(getTracksForRecordingLineageEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('mergeRecordingLineage', () => {
  const derivations: MbRecordingDerivation[] = [
    { recordingMbid: 'orig-1', title: 'Original Mix', type: 'remix', direction: 'forward' },
  ];

  it('MERGEs the fallback Recording, writes a type-keyed track-scoped RELATED_RECORDING with raw direction', async () => {
    const { session, runSpy } = makeMockSession();

    await mergeRecordingLineage(makeMockDriver(session), 'rec-1', ['e1', 'e2'], derivations);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    // The fallback Recording node is MBID-keyed on the OTHER recording; title only fills a gap —
    // including an empty-string gap (the client emits '' for a missing MB title, not null).
    expect(query).toContain('MERGE (rec:Recording { mbid: d.recordingMbid })');
    expect(query).toContain('ON CREATE SET rec.title = d.title');
    expect(query).toContain(
      "CASE WHEN coalesce(rec.title, '') = '' THEN d.title ELSE rec.title END",
    );
    // The edge merge key includes `type` so two derivative types to one target don't collapse.
    expect(query).toContain('MERGE (t)-[rel:RELATED_RECORDING { type: d.type }]->(rec)');
    expect(query).toContain('ON CREATE SET');
    expect(query).toContain("rel.source = 'musicbrainz'");
    expect(query).toContain('rel.direction = d.direction');
    expect(query).toContain('rel.recordingMbid = $recordingMbid');
    // The marker is stamped on every candidate track, not only edge-bearing ones.
    expect(query).toContain('t.recordingLineageFetchedAt = datetime()');
    expect(params.recordingMbid).toBe('rec-1');
    expect(params.trackElementIds).toEqual(['e1', 'e2']);
    expect(params.derivations).toEqual(derivations);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query when there are no derivations', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeRecordingLineage(makeMockDriver(session), 'rec-1', ['e1'], []);
    expect(runSpy).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeRecordingLineage(makeMockDriver(session), 'rec-1', [], derivations);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write error'));

    await expect(
      mergeRecordingLineage(makeMockDriver(session), 'rec-1', ['e1'], derivations),
    ).rejects.toThrow('write error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('setRecordingLineageFetched', () => {
  it('stamps recordingLineageFetchedAt on the given track element ids', async () => {
    const { session, runSpy } = makeMockSession();

    await setRecordingLineageFetched(makeMockDriver(session), ['e1']);

    const [query] = runSpy.mock.calls[0] as [string, unknown];
    expect(query).toContain('t.recordingLineageFetchedAt = datetime()');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await setRecordingLineageFetched(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('resetRecordingLineageEnrichment', () => {
  it('deletes MB lineage edges, prunes orphan Recording nodes, clears markers, returns the count', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue({ toNumber: () => 3 }) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [] }) // delete edges
      .mockResolvedValueOnce({ records: [] }) // prune orphan Recording nodes
      .mockResolvedValueOnce({ records: [resetRecord] }); // clear markers + count
    const session = {
      run: runSpy,
      executeWrite: vi.fn((fn: (tx: { run: typeof runSpy }) => unknown) => fn({ run: runSpy })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    const reset = await resetRecordingLineageEnrichment(makeMockDriver(session));

    expect(reset).toBe(3);
    expect(session.executeWrite).toHaveBeenCalledOnce();
    expect(runSpy).toHaveBeenCalledTimes(3);
    const deleteQuery = (runSpy.mock.calls[0] as [string])[0];
    expect(deleteQuery).toContain("r.source = 'musicbrainz'");
    expect(deleteQuery).toContain('DELETE r');
    const pruneQuery = (runSpy.mock.calls[1] as [string])[0];
    // Orphan Recording nodes (no remaining edges) are pure lineage targets — prune them.
    expect(pruneQuery).toContain('MATCH (rec:Recording) WHERE NOT (rec)--()');
    expect(pruneQuery).toContain('DETACH DELETE rec');
    expect((runSpy.mock.calls[2] as [string])[0]).toContain('REMOVE t.recordingLineageFetchedAt');
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

    expect(await resetRecordingLineageEnrichment(makeMockDriver(session))).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('reset failed'));

    await expect(resetRecordingLineageEnrichment(makeMockDriver(session))).rejects.toThrow(
      'reset failed',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
