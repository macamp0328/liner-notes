import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import {
  getTracksForRecordingPlacesEnrichment,
  mergeRecordingPlaces,
  setRecordingPlacesFetched,
  resetRecordingPlacesEnrichment,
} from '../../../src/db/track-recording-places-repository.js';
import type { MbRecordingPlace } from '../../../src/ingestion/musicbrainz-client.js';

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

describe('getTracksForRecordingPlacesEnrichment', () => {
  it('groups candidate track element ids by recordingMbid', async () => {
    const fakeRecord = {
      get: vi.fn((key: string) => (key === 'recordingMbid' ? 'rec-1' : ['e1', 'e2'])),
    };
    const result = { records: [fakeRecord] } as unknown as Result;
    const { session } = makeMockSession(result);

    const rows = await getTracksForRecordingPlacesEnrichment(makeMockDriver(session));

    expect(rows).toEqual([{ recordingMbid: 'rec-1', trackElementIds: ['e1', 'e2'] }]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('gates on recordingMbid, a source-scoped not-yet-studio guard, and the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] } as unknown as Result);

    await getTracksForRecordingPlacesEnrichment(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('t.recordingMbid IS NOT NULL');
    // Already-attributed Tracks must not be re-selected every staleness window — and the guard is
    // source-scoped so a future non-MB Track→Studio edge cannot wrongly exclude a candidate.
    expect(query).toContain('NOT EXISTS {');
    expect(query).toContain('(t)-[r:RECORDED_AT]->(:Studio)');
    expect(query).toContain("r.source = 'musicbrainz'");
    expect(query).toContain('t.recordingPlacesFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('collect(elementId(t)) AS trackElementIds');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    await expect(getTracksForRecordingPlacesEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('mergeRecordingPlaces', () => {
  const places: MbRecordingPlace[] = [
    {
      placeMbid: 'place-1',
      name: 'Abbey Road Studios',
      relation: 'recorded at',
      latitude: 51.53192,
      longitude: -0.17835,
      area: "St John's Wood",
    },
  ];

  it('MERGEs the Studio by name, fills coords via coalesce, and writes a track-scoped RECORDED_AT', async () => {
    const { session, runSpy } = makeMockSession();

    await mergeRecordingPlaces(makeMockDriver(session), 'rec-1', ['e1', 'e2'], places);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    // Name is the join key onto the existing Discogs-keyed Studio nodes.
    expect(query).toContain('MERGE (s:Studio { name: p.name })');
    // Coords only ever fill a gap — a later null-coord fetch never clobbers good data.
    expect(query).toContain('s.latitude = coalesce(p.latitude, s.latitude)');
    expect(query).toContain('s.longitude = coalesce(p.longitude, s.longitude)');
    expect(query).toContain('s.area = coalesce(p.area, s.area)');
    expect(query).toContain('s.musicbrainzPlaceId = coalesce(p.placeMbid, s.musicbrainzPlaceId)');
    // The edge never clobbers anything — ON CREATE only — and records provenance.
    expect(query).toContain('MERGE (t)-[ra:RECORDED_AT]->(s)');
    expect(query).toContain('ON CREATE SET');
    expect(query).toContain("ra.source = 'musicbrainz'");
    expect(query).toContain('ra.recordingMbid = $recordingMbid');
    expect(query).toContain('ra.relation = p.relation');
    // The marker is stamped on every candidate track, not only edge-bearing ones.
    expect(query).toContain('t.recordingPlacesFetchedAt = datetime()');
    expect(params.recordingMbid).toBe('rec-1');
    expect(params.trackElementIds).toEqual(['e1', 'e2']);
    expect(params.places).toEqual(places);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query when there are no places', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeRecordingPlaces(makeMockDriver(session), 'rec-1', ['e1'], []);
    expect(runSpy).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await mergeRecordingPlaces(makeMockDriver(session), 'rec-1', [], places);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write error'));

    await expect(
      mergeRecordingPlaces(makeMockDriver(session), 'rec-1', ['e1'], places),
    ).rejects.toThrow('write error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('setRecordingPlacesFetched', () => {
  it('stamps recordingPlacesFetchedAt on the given track element ids', async () => {
    const { session, runSpy } = makeMockSession();

    await setRecordingPlacesFetched(makeMockDriver(session), ['e1']);

    const [query] = runSpy.mock.calls[0] as [string, unknown];
    expect(query).toContain('t.recordingPlacesFetchedAt = datetime()');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query when there are no track element ids', async () => {
    const { session, runSpy } = makeMockSession();
    await setRecordingPlacesFetched(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('resetRecordingPlacesEnrichment', () => {
  it('deletes MB studio edges, clears markers, leaves Studio nodes intact, and returns the count', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue({ toNumber: () => 4 }) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [] }) // delete edges
      .mockResolvedValueOnce({ records: [resetRecord] }); // clear markers + count
    const session = {
      run: runSpy,
      executeWrite: vi.fn((fn: (tx: { run: typeof runSpy }) => unknown) => fn({ run: runSpy })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    const reset = await resetRecordingPlacesEnrichment(makeMockDriver(session));

    expect(reset).toBe(4);
    expect(session.executeWrite).toHaveBeenCalledOnce();
    expect(runSpy).toHaveBeenCalledTimes(2);
    const deleteQuery = (runSpy.mock.calls[0] as [string])[0];
    expect(deleteQuery).toContain("r.source = 'musicbrainz'");
    expect(deleteQuery).toContain('DELETE r');
    // Crucially, the reset never deletes Studio nodes (shared, name-keyed, hold coords for #342).
    expect(deleteQuery).not.toContain('DELETE s');
    expect(deleteQuery).not.toContain('DETACH DELETE');
    expect((runSpy.mock.calls[1] as [string])[0]).toContain('REMOVE t.recordingPlacesFetchedAt');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when no tracks had the marker', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue(undefined) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [resetRecord] });
    const session = {
      run: runSpy,
      executeWrite: vi.fn((fn: (tx: { run: typeof runSpy }) => unknown) => fn({ run: runSpy })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    expect(await resetRecordingPlacesEnrichment(makeMockDriver(session))).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('reset failed'));

    await expect(resetRecordingPlacesEnrichment(makeMockDriver(session))).rejects.toThrow(
      'reset failed',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
