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

/**
 * Coverage for a stage that draws from more than one source (lyrics: lrclib /
 * genius; nationality: musicbrainz / wikidata / viaf). `sources` splits the
 * covered total per source plus an `untagged` bucket — covered minus the known
 * sources — so the buckets sum to `covered` and any legacy/un-attributed
 * coverage is visible rather than silently dropped.
 */
export interface SourcedCoverageMetric extends CoverageMetric {
  sources: Record<string, CoverageMetric>;
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
    artistsWithGenres: CoverageMetric;
    artistsWithStyles: CoverageMetric;
    artistsWithNationality: SourcedCoverageMetric;
    musiciansWithNationality: SourcedCoverageMetric;
    producersWithNationality: SourcedCoverageMetric;
    engineersWithNationality: SourcedCoverageMetric;
    tracksWithLyrics: SourcedCoverageMetric;
    tracksWithRecordingMbid: CoverageMetric;
    tracksWithIsrc: CoverageMetric;
    tracksWithTempo: CoverageMetric;
    tracksWithDeezerBpm: CoverageMetric;
    tracksWithDeezerGain: CoverageMetric;
    tracksWithVersions: CoverageMetric;
    mastersWithReleaseEvents: CoverageMetric;
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

/**
 * Coverage for a multi-source stage. Each known source becomes a CoverageMetric
 * over the same `applicable` denominator; an `untagged` bucket absorbs the
 * remainder (covered − Σ known) so the per-source buckets always sum to the
 * parent `covered`. For lyrics this should be ~0; for nationality it holds edges
 * written before source-tagging existed, shrinking to 0 as re-runs tag them.
 */
function sourced(
  covered: number,
  applicable: number,
  bySource: Record<string, number>,
): SourcedCoverageMetric {
  const known = Object.values(bySource).reduce((sum, c) => sum + c, 0);
  const sources: Record<string, CoverageMetric> = Object.fromEntries(
    Object.entries(bySource).map(([name, c]) => [name, coverage(c, applicable)]),
  );
  sources.untagged = coverage(Math.max(0, covered - known), applicable);
  return { ...coverage(covered, applicable), sources };
}

// Per-label aggregation queries. Each uses count(CASE WHEN ...) so a single
// scan yields every tally for that label, and an aggregation over zero matched
// rows still returns one row of zeros — so the queries are safe on an empty
// graph (no MATCH-chaining across labels, which would collapse to no rows).
//
// Applicable gates mirror the enrichment selectors exactly:
//   - originalYear:  Release.masterDiscogsId IS NOT NULL        (master-data-repository)
//   - profile:       Artist.discogsId IS NOT NULL AND NOT IN [194, 355]  (artist-profiles-repository)
//   - genres/styles: artist has a release carrying a genre/style (artist-genres-repository)
//   - tempo:         Track.recordingMbid IS NOT NULL            (track-acousticbrainz-repository)
//   - deezerBpm/Gain: Track.isrc IS NOT NULL                    (track-deezer-repository)
const RELEASE_QUERY = `
  MATCH (r:Release)
  RETURN
    count(r) AS total,
    count(CASE WHEN r.masterDiscogsId IS NOT NULL THEN 1 END) AS oyApplicable,
    count(CASE WHEN r.masterDiscogsId IS NOT NULL AND r.originalYear IS NOT NULL THEN 1 END) AS oyCovered`;

const ARTIST_QUERY = `
  MATCH (a:Artist)
  WITH a,
    (a.discogsId IS NOT NULL AND NOT a.discogsId IN [194, 355]) AS applicable,
    EXISTS { (a)<-[:RELEASED_BY]-(:Release)-[:IN_GENRE]->(:Genre) } AS genreApp,
    EXISTS { (a)<-[:RELEASED_BY]-(:Release)-[:IN_STYLE]->(:Style) } AS styleApp
  RETURN
    count(a) AS total,
    count(CASE WHEN applicable THEN 1 END) AS profApplicable,
    count(CASE WHEN applicable AND a.profile IS NOT NULL THEN 1 END) AS profCovered,
    count(CASE WHEN genreApp THEN 1 END) AS genresApplicable,
    count(CASE WHEN genreApp AND a.genres IS NOT NULL AND size(a.genres) > 0 THEN 1 END) AS genresCovered,
    count(CASE WHEN styleApp THEN 1 END) AS stylesApplicable,
    count(CASE WHEN styleApp AND a.styles IS NOT NULL AND size(a.styles) > 0 THEN 1 END) AS stylesCovered`;

const TRACK_QUERY = `
  MATCH (t:Track)
  RETURN
    count(t) AS total,
    count(CASE WHEN t.lyrics IS NOT NULL THEN 1 END) AS lyricsCovered,
    count(CASE WHEN t.lyricsSource = 'lrclib' THEN 1 END) AS lyricsLrclibCovered,
    count(CASE WHEN t.lyricsSource = 'genius' THEN 1 END) AS lyricsGeniusCovered,
    count(CASE WHEN t.recordingMbid IS NOT NULL THEN 1 END) AS mbidCovered,
    count(CASE WHEN t.isrc IS NOT NULL THEN 1 END) AS isrcCovered,
    count(CASE WHEN t.recordingMbid IS NOT NULL AND t.tempo IS NOT NULL THEN 1 END) AS tempoCovered,
    count(CASE WHEN t.isrc IS NOT NULL AND t.deezerBpm IS NOT NULL THEN 1 END) AS deezerCovered,
    count(CASE WHEN t.isrc IS NOT NULL AND t.deezerGain IS NOT NULL THEN 1 END) AS deezerGainCovered,
    // Undirected by intent: counts every track in a version cluster (both the variants and
    // the earliest pressing they point at), i.e. "participates in versioning" — the signal
    // that the track-versions stage produced output, not "has an earlier version".
    count(CASE WHEN EXISTS { (t)-[:IS_VERSION_OF]-() } THEN 1 END) AS versionsCovered`;

const MASTER_QUERY = `
  MATCH (m:Master)
  RETURN
    count(m) AS total,
    count(CASE WHEN EXISTS { (m)-[:MB_RELEASED_IN]->() } THEN 1 END) AS releaseEventsCovered`;

// Nationality (ORIGIN_COUNTRY) coverage for one people-label, split by the
// `source` stored on the relationship. One scan per label (Artist/Musician/
// Producer/Engineer); the applicable gate mirrors that label's enrichment
// selector. `label` and `applicableExpr` are hardcoded literals — no injection.
function nationalityQuery(label: string, applicableExpr: string): string {
  return `
    MATCH (p:${label})
    WITH p, (${applicableExpr}) AS app
    RETURN
      count(CASE WHEN app THEN 1 END) AS applicable,
      count(CASE WHEN app AND EXISTS { (p)-[:ORIGIN_COUNTRY]->() } THEN 1 END) AS covered,
      count(CASE WHEN app AND EXISTS { MATCH (p)-[r:ORIGIN_COUNTRY]->() WHERE r.source = 'musicbrainz' } THEN 1 END) AS mb,
      count(CASE WHEN app AND EXISTS { MATCH (p)-[r:ORIGIN_COUNTRY]->() WHERE r.source = 'wikidata' } THEN 1 END) AS wikidata,
      count(CASE WHEN app AND EXISTS { MATCH (p)-[r:ORIGIN_COUNTRY]->() WHERE r.source = 'viaf' } THEN 1 END) AS viaf`;
}

const ARTIST_NATIONALITY_QUERY = nationalityQuery(
  'Artist',
  'p.discogsId IS NOT NULL AND NOT p.discogsId IN [194, 355]',
);
const MUSICIAN_NATIONALITY_QUERY = nationalityQuery('Musician', 'true');
const PRODUCER_NATIONALITY_QUERY = nationalityQuery('Producer', 'true');
const ENGINEER_NATIONALITY_QUERY = nationalityQuery('Engineer', 'true');

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
  const [release, artist, track, master, natArtist, natMusician, natProducer, natEngineer] =
    await Promise.all([
      runCounts(driver, RELEASE_QUERY),
      runCounts(driver, ARTIST_QUERY),
      runCounts(driver, TRACK_QUERY),
      runCounts(driver, MASTER_QUERY),
      runCounts(driver, ARTIST_NATIONALITY_QUERY),
      runCounts(driver, MUSICIAN_NATIONALITY_QUERY),
      runCounts(driver, PRODUCER_NATIONALITY_QUERY),
      runCounts(driver, ENGINEER_NATIONALITY_QUERY),
    ]);

  const n = (m: Map<string, number>, key: string): number => m.get(key) ?? 0;

  const trackTotal = n(track, 'total');
  const mbidCovered = n(track, 'mbidCovered');
  const isrcCovered = n(track, 'isrcCovered');

  const nationality = (m: Map<string, number>): SourcedCoverageMetric =>
    sourced(n(m, 'covered'), n(m, 'applicable'), {
      musicbrainz: n(m, 'mb'),
      wikidata: n(m, 'wikidata'),
      viaf: n(m, 'viaf'),
    });

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
      artistsWithGenres: coverage(n(artist, 'genresCovered'), n(artist, 'genresApplicable')),
      artistsWithStyles: coverage(n(artist, 'stylesCovered'), n(artist, 'stylesApplicable')),
      artistsWithNationality: nationality(natArtist),
      musiciansWithNationality: nationality(natMusician),
      producersWithNationality: nationality(natProducer),
      engineersWithNationality: nationality(natEngineer),
      tracksWithLyrics: sourced(n(track, 'lyricsCovered'), trackTotal, {
        lrclib: n(track, 'lyricsLrclibCovered'),
        genius: n(track, 'lyricsGeniusCovered'),
      }),
      tracksWithRecordingMbid: coverage(mbidCovered, trackTotal),
      tracksWithIsrc: coverage(isrcCovered, trackTotal),
      // Applicable denominators are the upstream gates: tempo needs a recordingMbid,
      // deezerBpm/deezerGain need an isrc (both produced by track-musicbrainz enrichment).
      tracksWithTempo: coverage(n(track, 'tempoCovered'), mbidCovered),
      tracksWithDeezerBpm: coverage(n(track, 'deezerCovered'), isrcCovered),
      tracksWithDeezerGain: coverage(n(track, 'deezerGainCovered'), isrcCovered),
      tracksWithVersions: coverage(n(track, 'versionsCovered'), trackTotal),
      mastersWithReleaseEvents: coverage(n(master, 'releaseEventsCovered'), n(master, 'total')),
    },
  };
}
