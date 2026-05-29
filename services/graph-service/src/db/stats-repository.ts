import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/** Coerce a Neo4j count (Integer or plain number) to a JS number. */
function toNumber(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return raw;
  if (typeof (raw as Neo4jInt).toNumber === 'function') return (raw as Neo4jInt).toNumber();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coverage of a single enrichment, expressed as covered/applicable.
 * `applicable` is the denominator that excludes nodes the enrichment can't
 * reach (e.g. releasesWithOriginalYear only counts releases that have a
 * masterDiscogsId). `pct` is null when nothing is applicable, to avoid
 * reporting a misleading 0% for a metric that simply has no candidates yet.
 */
export interface CoverageMetric {
  covered: number;
  applicable: number;
  pct: number | null;
}

export interface StatsData {
  counts: {
    releases: number;
    artists: number;
    tracks: number;
    masters: number;
  };
  enrichment: {
    releasesWithOriginalYear: CoverageMetric;
    artistsWithProfile: CoverageMetric;
    tracksWithLyrics: CoverageMetric;
    tracksWithRecordingMbid: CoverageMetric;
    tracksWithIsrc: CoverageMetric;
    tracksWithTempo: CoverageMetric;
    tracksWithDeezerBpm: CoverageMetric;
  };
}

function coverage(covered: number, applicable: number): CoverageMetric {
  return {
    covered,
    applicable,
    // One decimal place; null when there are no applicable nodes.
    pct: applicable === 0 ? null : Math.round((covered / applicable) * 1000) / 10,
  };
}

// Per-label aggregation queries. Each uses count(CASE WHEN ...) so a single
// scan yields every tally for that label, and an aggregation over zero matched
// rows still returns one row of zeros — so the queries are safe on an empty
// graph (no MATCH-chaining across labels, which would collapse to no rows).
//
// Applicable gates mirror the enrichment selectors exactly:
//   - originalYear:  Release.masterDiscogsId IS NOT NULL        (master-data-repository)
//   - profile:       Artist.discogsId IS NOT NULL AND NOT IN [194, 355]  (artist-profiles-repository)
//   - tempo:         Track.recordingMbid IS NOT NULL            (track-acousticbrainz-repository)
//   - deezerBpm:     Track.isrc IS NOT NULL                     (track-deezer-repository)
const RELEASE_QUERY = `
  MATCH (r:Release)
  RETURN
    count(r) AS total,
    count(CASE WHEN r.masterDiscogsId IS NOT NULL THEN 1 END) AS oyApplicable,
    count(CASE WHEN r.masterDiscogsId IS NOT NULL AND r.originalYear IS NOT NULL THEN 1 END) AS oyCovered`;

const ARTIST_QUERY = `
  MATCH (a:Artist)
  WITH a, (a.discogsId IS NOT NULL AND NOT a.discogsId IN [194, 355]) AS applicable
  RETURN
    count(a) AS total,
    count(CASE WHEN applicable THEN 1 END) AS profApplicable,
    count(CASE WHEN applicable AND a.profile IS NOT NULL THEN 1 END) AS profCovered`;

const TRACK_QUERY = `
  MATCH (t:Track)
  RETURN
    count(t) AS total,
    count(CASE WHEN t.lyrics IS NOT NULL THEN 1 END) AS lyricsCovered,
    count(CASE WHEN t.recordingMbid IS NOT NULL THEN 1 END) AS mbidCovered,
    count(CASE WHEN t.isrc IS NOT NULL THEN 1 END) AS isrcCovered,
    count(CASE WHEN t.recordingMbid IS NOT NULL AND t.tempo IS NOT NULL THEN 1 END) AS tempoCovered,
    count(CASE WHEN t.isrc IS NOT NULL AND t.deezerBpm IS NOT NULL THEN 1 END) AS deezerCovered`;

const MASTER_QUERY = `MATCH (m:Master) RETURN count(m) AS total`;

async function runCounts(driver: Driver, cypher: string): Promise<Map<string, number>> {
  const session = driver.session();
  try {
    const result = await session.run(cypher);
    const record = result.records[0];
    const out = new Map<string, number>();
    if (record) {
      for (const key of record.keys as string[]) {
        out.set(key, toNumber(record.get(key)));
      }
    }
    return out;
  } finally {
    await session.close();
  }
}

/**
 * Aggregate node counts and per-enrichment coverage for the whole graph.
 * Runs one scan per label, in parallel. Cheap for a collection of this size;
 * the route layer caches the result so repeated public hits don't re-scan.
 */
export async function getStats(driver: Driver): Promise<StatsData> {
  const [release, artist, track, master] = await Promise.all([
    runCounts(driver, RELEASE_QUERY),
    runCounts(driver, ARTIST_QUERY),
    runCounts(driver, TRACK_QUERY),
    runCounts(driver, MASTER_QUERY),
  ]);

  const n = (m: Map<string, number>, key: string): number => m.get(key) ?? 0;

  const trackTotal = n(track, 'total');
  const mbidCovered = n(track, 'mbidCovered');
  const isrcCovered = n(track, 'isrcCovered');

  return {
    counts: {
      releases: n(release, 'total'),
      artists: n(artist, 'total'),
      tracks: trackTotal,
      masters: n(master, 'total'),
    },
    enrichment: {
      releasesWithOriginalYear: coverage(n(release, 'oyCovered'), n(release, 'oyApplicable')),
      artistsWithProfile: coverage(n(artist, 'profCovered'), n(artist, 'profApplicable')),
      tracksWithLyrics: coverage(n(track, 'lyricsCovered'), trackTotal),
      tracksWithRecordingMbid: coverage(mbidCovered, trackTotal),
      tracksWithIsrc: coverage(isrcCovered, trackTotal),
      // Applicable denominators are the upstream gates: tempo needs a recordingMbid,
      // deezerBpm needs an isrc (both produced by track-musicbrainz enrichment).
      tracksWithTempo: coverage(n(track, 'tempoCovered'), mbidCovered),
      tracksWithDeezerBpm: coverage(n(track, 'deezerCovered'), isrcCovered),
    },
  };
}
