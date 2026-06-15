import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session } from 'neo4j-driver';
import { reconcileWroteEdges } from '../../../src/db/songwriter-reconciliation-repository.js';

function makeNeo4jInt(n: number) {
  return { toNumber: () => n, low: n, high: 0 };
}

function makeMockSession(linkCounts: number[]): {
  driver: Driver;
  runSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  let callIndex = 0;
  const runSpy = vi.fn().mockImplementation(() => {
    const linked = linkCounts[callIndex] ?? 0;
    callIndex++;
    return Promise.resolve({
      records: [{ get: (k: string) => (k === 'linked' ? makeNeo4jInt(linked) : null) }],
    });
  });
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  // A fresh session per call (the repo opens one per pass), all sharing the spies.
  const driver = {
    session: vi.fn().mockReturnValue({ run: runSpy, close: closeSpy } as unknown as Session),
  } as unknown as Driver;
  return { driver, runSpy, closeSpy };
}

describe('reconcileWroteEdges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs an Artist pass and a Musician pass, summing the edges ensured', async () => {
    const { driver, runSpy } = makeMockSession([3, 5]);

    const total = await reconcileWroteEdges(driver);

    expect(total).toBe(8);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('joins on musicbrainzId by label, groups roles, and MERGEs WROTE tagged with source', async () => {
    const { driver, runSpy } = makeMockSession([1, 0]);

    await reconcileWroteEdges(driver);

    const artistQuery = runSpy.mock.calls[0]?.[0] as string;
    const musicianQuery = runSpy.mock.calls[1]?.[0] as string;
    expect(artistQuery).toContain('MATCH (p:Artist {musicbrainzId: mbid})');
    expect(musicianQuery).toContain('MATCH (p:Musician {musicbrainzId: mbid})');
    for (const q of [artistQuery, musicianQuery]) {
      expect(q).toContain('w.writerMbids IS NOT NULL');
      expect(q).toContain('UNWIND range(0, size(w.writerMbids) - 1) AS i');
      expect(q).toContain('collect(DISTINCT role) AS roles');
      expect(q).toContain('MERGE (p)-[rel:WROTE]->(w)');
      expect(q).toContain("rel.source = 'musicbrainz'");
      expect(q).toContain('rel.roles = roles');
    }
  });

  it('returns 0 when nothing matches', async () => {
    const { driver } = makeMockSession([0, 0]);
    expect(await reconcileWroteEdges(driver)).toBe(0);
  });
});
