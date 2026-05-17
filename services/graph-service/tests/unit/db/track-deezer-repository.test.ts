import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getTracksForDeezerEnrichment,
  setTrackDeezerData,
} from '../../../src/db/track-deezer-repository.js';

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

describe('getTracksForDeezerEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps records to { elementId, isrc }', async () => {
    const record1 = makeNeo4jRecord({ elementId: 'elem-1', isrc: 'USUM71900001' });
    const record2 = makeNeo4jRecord({ elementId: 'elem-2', isrc: 'GBUM71900002' });
    const { session } = makeMockSession({ records: [record1, record2] } as unknown as Result);

    const tracks = await getTracksForDeezerEnrichment(makeMockDriver(session));

    expect(tracks).toEqual([
      { elementId: 'elem-1', isrc: 'USUM71900001' },
      { elementId: 'elem-2', isrc: 'GBUM71900002' },
    ]);
  });

  it('returns an empty array when no tracks need enrichment', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const tracks = await getTracksForDeezerEnrichment(makeMockDriver(session));
    expect(tracks).toEqual([]);
  });

  it('queries for tracks with isrc but without deezerFetched', async () => {
    const { session, runSpy } = makeMockSession();
    await getTracksForDeezerEnrichment(makeMockDriver(session));

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('t.isrc IS NOT NULL');
    expect(query).toContain('t.deezerFetched IS NULL');
  });

  it('closes the session after the query', async () => {
    const { session } = makeMockSession();
    await getTracksForDeezerEnrichment(makeMockDriver(session));
    expect(session.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});

describe('setTrackDeezerData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs an UNWIND query with the provided results', async () => {
    const { session, runSpy } = makeMockSession();
    const results = [
      { elementId: 'elem-1', deezerBpm: 128.5, deezerGain: -6.2 },
      { elementId: 'elem-2', deezerBpm: null, deezerGain: null },
    ];

    await setTrackDeezerData(makeMockDriver(session), results);

    expect(runSpy).toHaveBeenCalledTimes(1);
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('UNWIND $results');
    expect(query).toContain('deezerFetched = true');
    expect(query).toContain('deezerBpm');
    expect(query).toContain('deezerGain');
    expect(params).toEqual({ results });
  });

  it('does not run a query when results is empty', async () => {
    const { session, runSpy } = makeMockSession();
    await setTrackDeezerData(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the session after writing', async () => {
    const { session } = makeMockSession();
    await setTrackDeezerData(makeMockDriver(session), [
      { elementId: 'elem-1', deezerBpm: 120.0, deezerGain: -5.0 },
    ]);
    expect(session.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});
