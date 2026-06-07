import { describe, it, expect, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { getStats } from '../../../src/db/stats-repository.js';

// Mimic a Neo4j Integer.
const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

/** A nationality-query result row: applicable/covered plus the per-source split. */
const nat = (applicable: number, covered: number, mb: number, wikidata: number, viaf: number) => ({
  applicable: int(applicable),
  covered: int(covered),
  mb: int(mb),
  wikidata: int(wikidata),
  viaf: int(viaf),
});

function makeRecord(fields: Record<string, unknown>): unknown {
  return {
    keys: Object.keys(fields),
    get: (k: string) => fields[k],
  };
}

/**
 * Build a mock driver whose session().run(cypher) returns the record matching
 * the queried label. getStats fires eight label queries via Promise.all, each on
 * its own session, so we route by a substring of the MATCH clause. The producer/
 * engineer nationality queries scan `(p:Musician)` too (role lives on CREDITED_ON,
 * not a label), so they're routed by their `roleCategory` gate — checked before the
 * generic `(p:Musician)` and the Release/Artist/Track/Master routes.
 */
function makeDriver(byLabel: {
  release: Record<string, unknown>;
  artist: Record<string, unknown>;
  track: Record<string, unknown>;
  master: Record<string, unknown>;
  natArtist: Record<string, unknown>;
  natMusician: Record<string, unknown>;
  natProducer: Record<string, unknown>;
  natEngineer: Record<string, unknown>;
}): Driver {
  const run = vi.fn(async (cypher: string) => {
    let fields: Record<string, unknown>;
    if (cypher.includes('(p:Artist)')) fields = byLabel.natArtist;
    else if (cypher.includes("roleCategory = 'producer'")) fields = byLabel.natProducer;
    else if (cypher.includes("roleCategory = 'engineer'")) fields = byLabel.natEngineer;
    else if (cypher.includes('(p:Musician)')) fields = byLabel.natMusician;
    else if (cypher.includes('(r:Release)')) fields = byLabel.release;
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
      artist: {
        total: int(20),
        profApplicable: int(16),
        profCovered: int(12),
        genresApplicable: int(18),
        genresCovered: int(18),
        stylesApplicable: int(15),
        stylesCovered: int(9),
      },
      track: {
        total: int(100),
        lyricsCovered: int(80),
        lyricsLrclibCovered: int(70),
        lyricsGeniusCovered: int(8),
        mbidCovered: int(70),
        isrcCovered: int(60),
        tempoCovered: int(35),
        deezerCovered: int(30),
        deezerGainCovered: int(24),
      },
      master: { total: int(7), releaseEventsCovered: int(5) },
      natArtist: nat(16, 12, 7, 4, 1),
      natMusician: nat(50, 30, 10, 5, 15),
      natProducer: nat(8, 4, 4, 0, 0),
      natEngineer: nat(6, 3, 1, 1, 0),
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

    // genres/styles gated by the artist's release→genre/style path
    expect(stats.enrichment.artistsWithGenres).toEqual({ covered: 18, applicable: 18, pct: 100 });
    expect(stats.enrichment.artistsWithStyles).toEqual({ covered: 9, applicable: 15, pct: 60 });

    // lyrics split by source; untagged absorbs covered − (lrclib + genius) = 2
    expect(stats.enrichment.tracksWithLyrics).toEqual({
      covered: 80,
      applicable: 100,
      pct: 80,
      sources: {
        lrclib: { covered: 70, applicable: 100, pct: 70 },
        genius: { covered: 8, applicable: 100, pct: 8 },
        untagged: { covered: 2, applicable: 100, pct: 2 },
      },
    });

    expect(stats.enrichment.tracksWithRecordingMbid).toEqual({
      covered: 70,
      applicable: 100,
      pct: 70,
    });
    expect(stats.enrichment.tracksWithIsrc).toEqual({ covered: 60, applicable: 100, pct: 60 });
    // tempo applicable = tracks with a recordingMbid (70); 35/70 = 50%
    expect(stats.enrichment.tracksWithTempo).toEqual({ covered: 35, applicable: 70, pct: 50 });
    // deezerBpm/deezerGain applicable = tracks with an isrc (60)
    expect(stats.enrichment.tracksWithDeezerBpm).toEqual({ covered: 30, applicable: 60, pct: 50 });
    expect(stats.enrichment.tracksWithDeezerGain).toEqual({ covered: 24, applicable: 60, pct: 40 });

    // 5/7 = 71.42857… → 71.4
    expect(stats.enrichment.mastersWithReleaseEvents).toEqual({
      covered: 5,
      applicable: 7,
      pct: 71.4,
    });

    // nationality, per-label, split by source; untagged = covered − Σ sources
    expect(stats.enrichment.artistsWithNationality).toEqual({
      covered: 12,
      applicable: 16,
      pct: 75,
      sources: {
        musicbrainz: { covered: 7, applicable: 16, pct: 43.8 },
        wikidata: { covered: 4, applicable: 16, pct: 25 },
        viaf: { covered: 1, applicable: 16, pct: 6.3 },
        untagged: { covered: 0, applicable: 16, pct: 0 },
      },
    });
    expect(stats.enrichment.musiciansWithNationality.sources.viaf).toEqual({
      covered: 15,
      applicable: 50,
      pct: 30,
    });
    // dead source: producers have zero wikidata/viaf coverage → pct 0, obvious at a glance
    expect(stats.enrichment.producersWithNationality.sources.wikidata!.pct).toBe(0);
    expect(stats.enrichment.producersWithNationality.sources.viaf!.pct).toBe(0);
    // legacy edges: engineer covered (3) exceeds tagged sources (1+1+0) → untagged 1
    expect(stats.enrichment.engineersWithNationality.sources.untagged).toEqual({
      covered: 1,
      applicable: 6,
      pct: 16.7,
    });
  });

  it('rounds percentages to one decimal place', async () => {
    const driver = makeDriver({
      release: { total: int(3), oyApplicable: int(3), oyCovered: int(1) }, // 33.333 → 33.3
      artist: { total: int(0), profApplicable: int(0), profCovered: int(0) },
      track: { total: int(0) },
      master: { total: int(0) },
      natArtist: {},
      natMusician: {},
      natProducer: {},
      natEngineer: {},
    });

    const stats = await getStats(driver);
    expect(stats.enrichment.releasesWithOriginalYear.pct).toBe(33.3);
  });

  it('reports pct null (not 0) when nothing is applicable — empty graph', async () => {
    const driver = makeDriver({
      release: { total: int(0), oyApplicable: int(0), oyCovered: int(0) },
      artist: { total: int(0) },
      track: { total: int(0) },
      master: { total: int(0) },
      natArtist: {},
      natMusician: {},
      natProducer: {},
      natEngineer: {},
    });

    const stats = await getStats(driver);

    expect(stats.counts).toEqual({ releases: 0, artists: 0, tracks: 0, masters: 0 });
    expect(stats.enrichment.releasesWithOriginalYear.pct).toBeNull();
    expect(stats.enrichment.artistsWithGenres.pct).toBeNull();
    expect(stats.enrichment.tracksWithLyrics.pct).toBeNull();
    expect(stats.enrichment.mastersWithReleaseEvents.pct).toBeNull();
    expect(stats.enrichment.tracksWithDeezerGain).toEqual({ covered: 0, applicable: 0, pct: null });
    // a sourced metric still has every bucket, each with pct null on an empty graph
    expect(stats.enrichment.artistsWithNationality.sources.viaf!.pct).toBeNull();
    expect(stats.enrichment.artistsWithNationality.sources.untagged!.pct).toBeNull();
  });
});
