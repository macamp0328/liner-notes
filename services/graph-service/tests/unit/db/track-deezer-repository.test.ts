import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getTracksForDeezerEnrichment,
  setTrackDeezerData,
  resetTrackDeezerEnrichment,
} from '../../../src/db/track-deezer-repository.js';
import type { TrackDeezerResult } from '../../../src/db/track-deezer-repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

// ---------------------------------------------------------------------------
// getTracksForDeezerEnrichment
// ---------------------------------------------------------------------------

describe('getTracksForDeezerEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no records', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const tracks = await getTracksForDeezerEnrichment(makeMockDriver(session));
    expect(tracks).toEqual([]);
  });

  it('maps records to TrackForDeezer', async () => {
    const record = makeNeo4jRecord({
      elementId: '4:abc:1',
      isrc: 'USUM71703861',
    });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);
    const tracks = await getTracksForDeezerEnrichment(makeMockDriver(session));

    expect(tracks).toEqual([{ elementId: '4:abc:1', isrc: 'USUM71703861' }]);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('isrc IS NOT NULL');
    expect(query).toContain('t.deezerBpm IS NULL AND t.deezerGain IS NULL');
    expect(query).toContain('t.deezerFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session after a successful query', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    await getTracksForDeezerEnrichment(makeMockDriver(session));
    expect(session.close as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setTrackDeezerData
// ---------------------------------------------------------------------------

describe('setTrackDeezerData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when results array is empty', async () => {
    const { session, runSpy } = makeMockSession();
    await setTrackDeezerData(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs an UNWIND statement that stamps deezerFetchedAt and sets deezerBpm and deezerGain', async () => {
    const { session, runSpy } = makeMockSession();
    const results: TrackDeezerResult[] = [
      { elementId: '4:abc:1', deezerBpm: 128.5, deezerGain: -8.3 },
    ];
    await setTrackDeezerData(makeMockDriver(session), results);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('UNWIND $results');
    expect(query).toContain('deezerFetchedAt = datetime()');
    expect(query).toContain('t.deezerBpm = res.deezerBpm');
    expect(query).toContain('t.deezerGain = res.deezerGain');
    expect(params).toHaveProperty('results', results);
  });

  it('passes null values through (null clears the property in Neo4j)', async () => {
    const { session, runSpy } = makeMockSession();
    const results: TrackDeezerResult[] = [
      { elementId: '4:abc:2', deezerBpm: null, deezerGain: null },
    ];
    await setTrackDeezerData(makeMockDriver(session), results);
    const [, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    const written = (params['results'] as TrackDeezerResult[])[0];
    expect(written?.deezerBpm).toBeNull();
    expect(written?.deezerGain).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetTrackDeezerEnrichment
// ---------------------------------------------------------------------------

describe('resetTrackDeezerEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the count of reset tracks', async () => {
    const record = makeNeo4jRecord({ reset: int(15) });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);
    const count = await resetTrackDeezerEnrichment(makeMockDriver(session));

    expect(count).toBe(15);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('deezerFetchedAt IS NOT NULL');
    expect(query).toContain('REMOVE');
    expect(query).toContain('deezerFetchedAt');
    expect(query).toContain('deezerBpm');
    expect(query).toContain('deezerGain');
  });

  it('returns 0 when no tracks had the fetched marker', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const count = await resetTrackDeezerEnrichment(makeMockDriver(session));
    expect(count).toBe(0);
  });
});
