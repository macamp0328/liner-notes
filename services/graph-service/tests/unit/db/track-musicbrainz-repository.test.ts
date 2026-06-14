import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getTracksForMusicBrainzEnrichment,
  setTrackMusicBrainzIds,
  resetTrackMusicBrainzEnrichment,
} from '../../../src/db/track-musicbrainz-repository.js';

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
    // executeWrite runs its callback with a tx whose run is the same spy (reset now runs in a tx).
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

function makeNeo4jRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

// ---------------------------------------------------------------------------
// getTracksForMusicBrainzEnrichment
// ---------------------------------------------------------------------------
describe('getTracksForMusicBrainzEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps release records, converting Neo4j integers and null durations', async () => {
    const record = makeNeo4jRecord({
      releaseDiscogsId: int(567),
      artistNames: ['Miles Davis'],
      tracks: [
        { elementId: 'n1', title: 'So What', position: 'A1', durationSeconds: int(545) },
        { elementId: 'n2', title: 'Blue in Green', position: 'A2', durationSeconds: null },
      ],
    });
    const { session } = makeMockSession({ records: [record] } as unknown as Result);
    const releases = await getTracksForMusicBrainzEnrichment(makeMockDriver(session));

    expect(releases).toEqual([
      {
        releaseDiscogsId: 567,
        artistNames: ['Miles Davis'],
        tracks: [
          { elementId: 'n1', title: 'So What', position: 'A1', durationSeconds: 545 },
          { elementId: 'n2', title: 'Blue in Green', position: 'A2', durationSeconds: null },
        ],
      },
    ]);
  });

  it('selects releases with tracks still missing a recordingMbid, gated by the staleness window', async () => {
    const { session, runSpy } = makeMockSession();
    await getTracksForMusicBrainzEnrichment(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('tx.recordingMbid IS NULL');
    expect(query).toContain('tx.musicBrainzFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(query).toContain('HAS_TRACK');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('returns an empty array when no releases need enrichment', async () => {
    const { session } = makeMockSession();
    const releases = await getTracksForMusicBrainzEnrichment(makeMockDriver(session));
    expect(releases).toEqual([]);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(getTracksForMusicBrainzEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setTrackMusicBrainzIds
// ---------------------------------------------------------------------------
describe('setTrackMusicBrainzIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early without a query when results are empty', async () => {
    const { session, runSpy } = makeMockSession();
    await setTrackMusicBrainzIds(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('sends an UNWIND query that stamps the timestamp marker and both identifiers', async () => {
    const { session, runSpy } = makeMockSession();
    const results = [
      { elementId: 'n1', recordingMbid: 'r1', isrc: 'I1' },
      { elementId: 'n2', recordingMbid: null, isrc: null },
    ];

    await setTrackMusicBrainzIds(makeMockDriver(session), results);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('UNWIND $results AS res');
    expect(query).toContain('t.musicBrainzFetchedAt = datetime()');
    expect(query).toContain('t.recordingMbid = res.recordingMbid');
    expect(query).toContain('t.isrc = res.isrc');
    expect(params['results']).toBe(results);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(
      setTrackMusicBrainzIds(makeMockDriver(session), [
        { elementId: 'n1', recordingMbid: 'r1', isrc: null },
      ]),
    ).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// resetTrackMusicBrainzEnrichment
// ---------------------------------------------------------------------------
describe('resetTrackMusicBrainzEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the number of tracks reset and cascades to track-works (#336)', async () => {
    const record = makeNeo4jRecord({ reset: int(42) });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);

    const reset = await resetTrackMusicBrainzEnrichment(makeMockDriver(session));

    expect(reset).toBe(42);
    // One transaction: REMOVE the markers (incl. worksFetchedAt), then delete every Work node.
    expect(session.executeWrite).toHaveBeenCalledOnce();
    const [removeQuery] = runSpy.mock.calls[0] as [string];
    expect(removeQuery).toContain('REMOVE t.musicBrainzFetchedAt, t.recordingMbid, t.isrc');
    expect(removeQuery).toContain('t.worksFetchedAt');
    expect(removeQuery).toContain('t.acousticBrainzFetchedAt, t.tempo, t.musicalKey');
    expect((runSpy.mock.calls[1] as [string])[0]).toContain('MATCH (w:Work) DETACH DELETE w');
  });

  it('returns 0 when the query yields no records', async () => {
    const { session } = makeMockSession();
    const reset = await resetTrackMusicBrainzEnrichment(makeMockDriver(session));
    expect(reset).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(resetTrackMusicBrainzEnrichment(makeMockDriver(session))).rejects.toThrow(
      'DB error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
