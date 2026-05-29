import { describe, it, expect, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { getStats } from '../../../src/db/stats-repository.js';

// Mimic a Neo4j Integer.
const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

function makeRecord(fields: Record<string, unknown>): unknown {
  return {
    keys: Object.keys(fields),
    get: (k: string) => fields[k],
  };
}

/**
 * Build a mock driver whose session().run(cypher) returns the record matching
 * the queried label. getStats fires the four label queries via Promise.all, each
 * on its own session, so we route by a substring of the MATCH clause.
 */
function makeDriver(byLabel: {
  release: Record<string, unknown>;
  artist: Record<string, unknown>;
  track: Record<string, unknown>;
  master: Record<string, unknown>;
}): Driver {
  const run = vi.fn(async (cypher: string) => {
    let fields: Record<string, unknown>;
    if (cypher.includes('(r:Release)')) fields = byLabel.release;
    else if (cypher.includes('(a:Artist)')) fields = byLabel.artist;
    else if (cypher.includes('(t:Track)')) fields = byLabel.track;
    else fields = byLabel.master;
    return { records: [makeRecord(fields)] };
  });
  const session = { run, close: vi.fn().mockResolvedValue(undefined) };
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

describe('getStats', () => {
  it('assembles counts and coverage with correct percentages', async () => {
    const driver = makeDriver({
      release: { total: int(10), oyApplicable: int(8), oyCovered: int(6) },
      artist: { total: int(20), profApplicable: int(16), profCovered: int(12) },
      track: {
        total: int(100),
        lyricsCovered: int(80),
        mbidCovered: int(70),
        isrcCovered: int(60),
        tempoCovered: int(35),
        deezerCovered: int(30),
      },
      master: { total: int(7) },
    });

    const stats = await getStats(driver);

    expect(stats.counts).toEqual({ releases: 10, artists: 20, tracks: 100, masters: 7 });

    // master-gated denominator
    expect(stats.enrichment.releasesWithOriginalYear).toEqual({
      covered: 6,
      applicable: 8,
      pct: 75,
    });
    expect(stats.enrichment.artistsWithProfile).toEqual({ covered: 12, applicable: 16, pct: 75 });
    // ungated: denominator is total tracks
    expect(stats.enrichment.tracksWithLyrics).toEqual({ covered: 80, applicable: 100, pct: 80 });
    expect(stats.enrichment.tracksWithRecordingMbid).toEqual({
      covered: 70,
      applicable: 100,
      pct: 70,
    });
    expect(stats.enrichment.tracksWithIsrc).toEqual({ covered: 60, applicable: 100, pct: 60 });
    // tempo applicable = tracks with a recordingMbid (70); 35/70 = 50%
    expect(stats.enrichment.tracksWithTempo).toEqual({ covered: 35, applicable: 70, pct: 50 });
    // deezer applicable = tracks with an isrc (60); 30/60 = 50%
    expect(stats.enrichment.tracksWithDeezerBpm).toEqual({ covered: 30, applicable: 60, pct: 50 });
  });

  it('rounds percentages to one decimal place', async () => {
    const driver = makeDriver({
      release: { total: int(3), oyApplicable: int(3), oyCovered: int(1) }, // 33.333 → 33.3
      artist: { total: int(0), profApplicable: int(0), profCovered: int(0) },
      track: {
        total: int(0),
        lyricsCovered: int(0),
        mbidCovered: int(0),
        isrcCovered: int(0),
        tempoCovered: int(0),
        deezerCovered: int(0),
      },
      master: { total: int(0) },
    });

    const stats = await getStats(driver);
    expect(stats.enrichment.releasesWithOriginalYear.pct).toBe(33.3);
  });

  it('reports pct null (not 0) when nothing is applicable — empty graph', async () => {
    const zeros = (extra: Record<string, number> = {}) => {
      const base: Record<string, unknown> = { total: int(0) };
      for (const k of Object.keys(extra)) base[k] = int(0);
      return base;
    };
    const driver = makeDriver({
      release: zeros({ oyApplicable: 0, oyCovered: 0 }),
      artist: zeros({ profApplicable: 0, profCovered: 0 }),
      track: zeros({
        lyricsCovered: 0,
        mbidCovered: 0,
        isrcCovered: 0,
        tempoCovered: 0,
        deezerCovered: 0,
      }),
      master: zeros(),
    });

    const stats = await getStats(driver);

    expect(stats.counts).toEqual({ releases: 0, artists: 0, tracks: 0, masters: 0 });
    expect(stats.enrichment.releasesWithOriginalYear.pct).toBeNull();
    expect(stats.enrichment.tracksWithLyrics.pct).toBeNull();
    expect(stats.enrichment.tracksWithTempo.pct).toBeNull();
    expect(stats.enrichment.tracksWithDeezerBpm).toEqual({ covered: 0, applicable: 0, pct: null });
  });
});
