import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getTracksForSpotifyEnrichment,
  setTrackAudioFeatures,
} from '../../../src/db/spotify-audio-repository.js';

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
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeNeo4jRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

const sampleFeatures = {
  id: 'spotify-id-1',
  spotifyMatchConfidence: 'high' as const,
  timeSignature: 4,
  tempo: 120.5,
  key: 5,
  mode: 1,
  loudness: -8.5,
  energy: 0.75,
  valence: 0.6,
  danceability: 0.7,
  acousticness: 0.1,
  instrumentalness: 0.05,
  liveness: 0.12,
  speechiness: 0.04,
};

// ---------------------------------------------------------------------------
// getTracksForSpotifyEnrichment
// ---------------------------------------------------------------------------
describe('getTracksForSpotifyEnrichment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped SpotifyTrackCandidate[] from query records', async () => {
    const fakeId = { toNumber: () => 12345, low: 12345, high: 0 };
    const fakeDuration = { toNumber: () => 200, low: 200, high: 0 };
    const record = makeNeo4jRecord({
      title: 'Test Track',
      position: 'A1',
      releaseDiscogsId: fakeId,
      durationSeconds: fakeDuration,
      artistName: 'Test Artist',
    });
    const result = { records: [record] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const tracks = await getTracksForSpotifyEnrichment(driver);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({
      title: 'Test Track',
      position: 'A1',
      releaseDiscogsId: 12345,
      durationSeconds: 200,
      artistName: 'Test Artist',
    });
  });

  it('returns null artistName when no artist is linked', async () => {
    const fakeId = { toNumber: () => 99999, low: 99999, high: 0 };
    const fakeDuration = { toNumber: () => 180, low: 180, high: 0 };
    const record = makeNeo4jRecord({
      title: 'No Artist',
      position: 'B1',
      releaseDiscogsId: fakeId,
      durationSeconds: fakeDuration,
      artistName: null,
    });
    const result = { records: [record] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const tracks = await getTracksForSpotifyEnrichment(driver);
    expect(tracks[0]?.artistName).toBeNull();
  });

  it('returns empty array when no eligible tracks exist', async () => {
    const result = { records: [] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const tracks = await getTracksForSpotifyEnrichment(driver);
    expect(tracks).toEqual([]);
  });

  it('queries WHERE spotifyId IS NULL AND durationSeconds IS NOT NULL', async () => {
    const result = { records: [] } as unknown as Result;
    const { session, runSpy } = makeMockSession(result);
    const driver = makeMockDriver(session);

    await getTracksForSpotifyEnrichment(driver);

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('t.spotifyId IS NULL');
    expect(query).toContain('t.durationSeconds IS NOT NULL');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const driver = makeMockDriver(session);

    await expect(getTracksForSpotifyEnrichment(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setTrackAudioFeatures
// ---------------------------------------------------------------------------
describe('setTrackAudioFeatures', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends a SET query targeting the correct Release and Track', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await setTrackAudioFeatures(driver, 12345, 'A1', sampleFeatures);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain(
      'MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})',
    );
    expect(query).toContain('SET t.spotifyId = $spotifyId');
    expect(params['position']).toBe('A1');
    expect(params['spotifyId']).toBe('spotify-id-1');
    expect(params['spotifyMatchConfidence']).toBe('high');
    expect(params['tempo']).toBe(120.5);
    expect(params['loudness']).toBe(-8.5);
  });

  it('wraps integer fields in neo4j.int()', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await setTrackAudioFeatures(driver, 12345, 'A1', sampleFeatures);

    const [, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    const id = params['releaseDiscogsId'] as { toNumber(): number };
    expect(typeof id.toNumber).toBe('function');
    expect(id.toNumber()).toBe(12345);

    const ts = params['timeSignature'] as { toNumber(): number };
    expect(ts.toNumber()).toBe(4);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write error'));
    const driver = makeMockDriver(session);

    await expect(setTrackAudioFeatures(driver, 1, 'A1', sampleFeatures)).rejects.toThrow(
      'write error',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });
});
