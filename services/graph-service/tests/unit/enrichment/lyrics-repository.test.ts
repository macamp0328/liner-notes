import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result, Record as Neo4jRecord } from 'neo4j-driver';
import {
  getUnenrichedTracks,
  setTrackLyrics,
  clearGeniusLyrics,
} from '../../../src/db/lyrics-repository.js';

// ---------------------------------------------------------------------------
// Mock neo4j-driver — test that the right Cypher is sent, not that Neo4j
// actually executes it. Patch neo4j.int() to return a plain object.
// ---------------------------------------------------------------------------
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
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

function makeNeo4jRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

// ---------------------------------------------------------------------------
// getUnenrichedTracks
// ---------------------------------------------------------------------------
describe('getUnenrichedTracks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns mapped UnenrichedTrack[] from query records', async () => {
    const fakeId = { toNumber: () => 13570466, low: 13570466, high: 0 };
    const record = makeNeo4jRecord({
      title: 'Blue in Green',
      position: 'A2',
      releaseDiscogsId: fakeId,
      artistName: 'Miles Davis',
    });
    const result = { records: [record] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const tracks = await getUnenrichedTracks(driver);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({
      title: 'Blue in Green',
      position: 'A2',
      releaseDiscogsId: 13570466,
      artistName: 'Miles Davis',
    });
  });

  it('returns null artistName when no artist is linked to the release', async () => {
    const fakeId = { toNumber: () => 9999991, low: 9999991, high: 0 };
    const record = makeNeo4jRecord({
      title: 'Untitled',
      position: 'B1',
      releaseDiscogsId: fakeId,
      artistName: null,
    });
    const result = { records: [record] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const tracks = await getUnenrichedTracks(driver);

    expect(tracks[0]?.artistName).toBeNull();
  });

  it('returns empty array when no unenriched tracks exist', async () => {
    const result = { records: [] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const tracks = await getUnenrichedTracks(driver);

    expect(tracks).toEqual([]);
  });

  it('sends a query that filters WHERE t.lyrics IS NULL', async () => {
    const result = { records: [] } as unknown as Result;
    const { session, runSpy } = makeMockSession(result);
    const driver = makeMockDriver(session);

    await getUnenrichedTracks(driver);

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('WHERE t.lyrics IS NULL');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const driver = makeMockDriver(session);

    await expect(getUnenrichedTracks(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// setTrackLyrics
// ---------------------------------------------------------------------------
describe('setTrackLyrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a SET query targeting the correct Release and Track', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await setTrackLyrics(driver, 13570466, 'A2', 'Verse\nLine', 'lrclib');

    expect(runSpy).toHaveBeenCalledOnce();
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain(
      'MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})',
    );
    expect(query).toContain('SET t.lyrics = $lyrics, t.lyricsSource = $lyricsSource');
    expect(params['position']).toBe('A2');
    expect(params['lyrics']).toBe('Verse\nLine');
    expect(params['lyricsSource']).toBe('lrclib');
  });

  it('wraps releaseDiscogsId in neo4j.int()', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await setTrackLyrics(driver, 13570466, 'A2', 'Some lyrics', 'genius');

    const [, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    // neo4j.int() is mocked to return { toNumber, low, high }
    const id = params['releaseDiscogsId'] as { toNumber(): number };
    expect(typeof id.toNumber).toBe('function');
    expect(id.toNumber()).toBe(13570466);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const driver = makeMockDriver(session);

    await expect(setTrackLyrics(driver, 1, 'A1', 'lyrics', 'lrclib')).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('clearGeniusLyrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the count of cleared tracks', async () => {
    const int = (n: number) => ({ toNumber: () => n });
    const record = {
      get: vi.fn().mockImplementation((key: string) => (key === 'cleared' ? int(3) : null)),
    };
    const { session } = makeMockSession({ records: [record] } as unknown as Result);

    const count = await clearGeniusLyrics(makeMockDriver(session));
    expect(count).toBe(3);
  });

  it('returns 0 when no tracks were cleared', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const count = await clearGeniusLyrics(makeMockDriver(session));
    expect(count).toBe(0);
  });
});
