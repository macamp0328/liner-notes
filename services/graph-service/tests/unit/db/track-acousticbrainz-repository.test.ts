import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getTracksForAcousticBrainzEnrichment,
  setTrackAcousticBrainzFeatures,
  resetTrackAcousticBrainzEnrichment,
} from '../../../src/db/track-acousticbrainz-repository.js';
import type { TrackAcousticBrainzResult } from '../../../src/db/track-acousticbrainz-repository.js';

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
// getTracksForAcousticBrainzEnrichment
// ---------------------------------------------------------------------------

describe('getTracksForAcousticBrainzEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no records', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const tracks = await getTracksForAcousticBrainzEnrichment(makeMockDriver(session));
    expect(tracks).toEqual([]);
  });

  it('maps records to TrackForAcousticBrainz', async () => {
    const record = makeNeo4jRecord({
      elementId: '4:abc:1',
      recordingMbid: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);
    const tracks = await getTracksForAcousticBrainzEnrichment(makeMockDriver(session));

    expect(tracks).toEqual([
      { elementId: '4:abc:1', recordingMbid: 'aaaaaaaa-0000-0000-0000-000000000001' },
    ]);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('recordingMbid IS NOT NULL');
    expect(query).toContain('t.tempo IS NULL');
    expect(query).toContain('t.acousticBrainzFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session after a successful query', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const driver = makeMockDriver(session);
    await getTracksForAcousticBrainzEnrichment(driver);
    expect(session.close as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setTrackAcousticBrainzFeatures
// ---------------------------------------------------------------------------

describe('setTrackAcousticBrainzFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when results array is empty', async () => {
    const { session, runSpy } = makeMockSession();
    await setTrackAcousticBrainzFeatures(makeMockDriver(session), []);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs an UNWIND statement that stamps acousticBrainzFetchedAt and all feature props', async () => {
    const { session, runSpy } = makeMockSession();
    const results: TrackAcousticBrainzResult[] = [
      {
        elementId: '4:abc:1',
        tempo: 130.5,
        musicalKey: 'C',
        musicalScale: 'minor',
        loudnessDb: 0.8,
        dynamicComplexity: 5.2,
        danceabilityEstimate: 0.75,
        voiceInstrumental: 'voice',
      },
    ];
    await setTrackAcousticBrainzFeatures(makeMockDriver(session), results);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('UNWIND $results');
    expect(query).toContain('acousticBrainzFetchedAt = datetime()');
    expect(query).toContain('t.tempo = res.tempo');
    expect(query).toContain('t.musicalKey = res.musicalKey');
    expect(query).toContain('t.voiceInstrumental = res.voiceInstrumental');
    expect(params).toHaveProperty('results', results);
  });

  it('handles nullable features in the result (null values pass through)', async () => {
    const { session, runSpy } = makeMockSession();
    const results: TrackAcousticBrainzResult[] = [
      {
        elementId: '4:abc:2',
        tempo: null,
        musicalKey: null,
        musicalScale: null,
        loudnessDb: null,
        dynamicComplexity: null,
        danceabilityEstimate: null,
        voiceInstrumental: null,
      },
    ];
    await setTrackAcousticBrainzFeatures(makeMockDriver(session), results);
    const [, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect((params['results'] as TrackAcousticBrainzResult[])[0]?.tempo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetTrackAcousticBrainzEnrichment
// ---------------------------------------------------------------------------

describe('resetTrackAcousticBrainzEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the count of reset tracks', async () => {
    const record = makeNeo4jRecord({ reset: int(42) });
    const { session, runSpy } = makeMockSession({ records: [record] } as unknown as Result);
    const count = await resetTrackAcousticBrainzEnrichment(makeMockDriver(session));

    expect(count).toBe(42);
    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('acousticBrainzFetchedAt IS NOT NULL');
    expect(query).toContain('REMOVE');
  });

  it('returns 0 when no tracks had the fetched marker', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const count = await resetTrackAcousticBrainzEnrichment(makeMockDriver(session));
    expect(count).toBe(0);
  });
});
