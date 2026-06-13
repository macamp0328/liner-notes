import type { Driver } from 'neo4j-driver';
import { toInt } from './coercions.js';

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
 * genius; nationality: musicbrainz / wikidata). `sources` splits the covered
 * total per source plus an `untagged` bucket — covered minus the known sources —
 * so the buckets sum to `covered` and any legacy/un-attributed coverage is
 * visible rather than silently dropped.
 */
export interface SourcedCoverageMetric extends CoverageMetric {
  sources: Record<string, CoverageMetric>;
}

/**
 * The lyrics funnel (issues #246, #248). The buckets partition `total` exactly:
 * `resolved` is ground-truth `lyrics IS NOT NULL` (so it counts legacy tracks enriched
 * before `lyricsStatus` existed), `instrumental`/`probableInstrumental` are the terminal
 * no-lyrics classifications, `lowConfidence` is a candidate whose best match the gate rejected
 * (#248, lyrics still null), and `notFound` is the derived remainder (everything else still
 * eligible for a retry — whether stamped `not-found` or never attempted).
 */
export interface LyricsFunnel {
  resolved: number;
  instrumental: number;
  probableInstrumental: number;
  lowConfidence: number;
  notFound: number;
  total: number;
}

export interface StatsData {
  counts: {
    releases: number;
    artists: number;
    tracks: number;
    masters: number;
    musicians: number;
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
    lyricsFunnel: LyricsFunnel;
    tracksWithRecordingMbid: CoverageMetric;
    tracksWithIsrc: CoverageMetric;
    tracksWithTempo: CoverageMetric;
    tracksWithDeezerBpm: CoverageMetric;
    tracksWithDeezerGain: CoverageMetric;
    mastersWithReleaseEvents: CoverageMetric;
    // Entity resolution (#330). samePersonLinks IS a CoverageMetric (gated by the reload verify
    // pass — covered/applicable over reconcilable Musicians). memberOfEdges/groupsWithMembers are
    // raw counts (MEMBER_OF has no knowable denominator); not CoverageMetrics, so the verify gate's
    // CoverageMetricKey skips them, like lyricsFunnel.
    samePersonLinks: CoverageMetric;
    memberOfEdges: number;
    groupsWithMembers: number;
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
    // Per-source split of covered, so it must gate on lyrics being present: a low-confidence
    // track (#248) carries a lyricsSource for provenance but has NULL lyrics, so without this gate
    // it would inflate the source bucket past covered and drive the untagged bucket negative.
    count(CASE WHEN t.lyrics IS NOT NULL AND t.lyricsSource = 'lrclib' THEN 1 END) AS lyricsLrclibCovered,
    count(CASE WHEN t.lyrics IS NOT NULL AND t.lyricsSource = 'genius' THEN 1 END) AS lyricsGeniusCovered,
    count(CASE WHEN t.lyrics IS NULL AND t.lyricsStatus = 'instrumental' THEN 1 END) AS lyricsInstrumental,
    count(CASE WHEN t.lyrics IS NULL AND t.lyricsStatus = 'probable-instrumental' THEN 1 END) AS lyricsProbableInstrumental,
    count(CASE WHEN t.lyrics IS NULL AND t.lyricsStatus = 'low-confidence' THEN 1 END) AS lyricsLowConfidence,
    count(CASE WHEN t.recordingMbid IS NOT NULL THEN 1 END) AS mbidCovered,
    count(CASE WHEN t.isrc IS NOT NULL THEN 1 END) AS isrcCovered,
    count(CASE WHEN t.recordingMbid IS NOT NULL AND t.tempo IS NOT NULL THEN 1 END) AS tempoCovered,
    count(CASE WHEN t.isrc IS NOT NULL AND t.deezerBpm IS NOT NULL THEN 1 END) AS deezerCovered,
    count(CASE WHEN t.isrc IS NOT NULL AND t.deezerGain IS NOT NULL THEN 1 END) AS deezerGainCovered`;

const MASTER_QUERY = `
  MATCH (m:Master)
  RETURN
    count(m) AS total,
    count(CASE WHEN EXISTS { (m)-[:MB_RELEASED_IN]->() } THEN 1 END) AS releaseEventsCovered`;

// Entity-resolution (#330) per-Musician scan. samePersonApplicable = Musicians whose discogsId
// matches an Artist (the reconciliation target set); samePersonCovered = those already linked via
// SAME_PERSON_AS. After the deterministic, exhaustive reconciliation pass runs, covered == applicable
// — which is what makes the reload verify gate's minPct:100 meaningful. groupsWithMembers counts
// Musician nodes that are a group (≥1 incoming MEMBER_OF). One scan; an aggregation over zero rows
// still returns a row of zeros, so this is empty-graph safe.
const MUSICIAN_QUERY = `
  MATCH (m:Musician)
  WITH m, (m.discogsId IS NOT NULL AND EXISTS { MATCH (a:Artist) WHERE a.discogsId = m.discogsId }) AS samePersonApp
  RETURN
    count(m) AS total,
    count(CASE WHEN samePersonApp THEN 1 END) AS samePersonApplicable,
    count(CASE WHEN samePersonApp AND EXISTS { MATCH (m)-[:SAME_PERSON_AS]->(a2:Artist) WHERE a2.discogsId = m.discogsId } THEN 1 END) AS samePersonCovered,
    count(CASE WHEN EXISTS { (:Musician)-[:MEMBER_OF]->(m) } THEN 1 END) AS groupsWithMembers`;

// MEMBER_OF edge count — a relationship scan can't ride the node scan above. count() over zero
// matched rows returns one row with 0, so this is empty-graph safe.
const MEMBER_OF_QUERY = `
  MATCH (:Musician)-[r:MEMBER_OF]->(:Musician)
  RETURN count(r) AS memberOfEdges`;

// Nationality (ORIGIN_COUNTRY) coverage for one people-label, split by the
// `source` stored on the relationship. One scan per label; the applicable gate
// mirrors that label's enrichment selector. `label` and `applicableExpr` are
// hardcoded literals — no injection.
//
// Producers and engineers are not their own node labels — every credited person
// is a Musician, with the role on CREDITED_ON.roleCategory. So those two metrics
// scan Musician with a role gate and therefore OVERLAP musiciansWithNationality
// by design (a person can hold multiple roles); the buckets do not partition.
function nationalityQuery(label: string, applicableExpr: string): string {
  return `
    MATCH (p:${label})
    WITH p, (${applicableExpr}) AS app
    RETURN
      count(CASE WHEN app THEN 1 END) AS applicable,
      count(CASE WHEN app AND EXISTS { (p)-[:ORIGIN_COUNTRY]->() } THEN 1 END) AS covered,
      count(CASE WHEN app AND EXISTS { MATCH (p)-[r:ORIGIN_COUNTRY]->() WHERE r.source = 'musicbrainz' } THEN 1 END) AS mb,
      count(CASE WHEN app AND EXISTS { MATCH (p)-[r:ORIGIN_COUNTRY]->() WHERE r.source = 'wikidata' } THEN 1 END) AS wikidata`;
}

const ARTIST_NATIONALITY_QUERY = nationalityQuery(
  'Artist',
  'p.discogsId IS NOT NULL AND NOT p.discogsId IN [194, 355]',
);
const MUSICIAN_NATIONALITY_QUERY = nationalityQuery('Musician', 'true');
const PRODUCER_NATIONALITY_QUERY = nationalityQuery(
  'Musician',
  "EXISTS { MATCH (p)-[c:CREDITED_ON]->() WHERE c.roleCategory = 'producer' }",
);
const ENGINEER_NATIONALITY_QUERY = nationalityQuery(
  'Musician',
  "EXISTS { MATCH (p)-[c:CREDITED_ON]->() WHERE c.roleCategory = 'engineer' }",
);

async function runCounts(driver: Driver, cypher: string): Promise<Map<string, number>> {
  const session = driver.session();
  try {
    const result = await session.run(cypher);
    const record = result.records[0];
    const out = new Map<string, number>();
    if (record) {
      for (const key of record.keys as string[]) {
        // Count columns are always Neo4j Integers; ?? 0 preserves the prior 0-default.
        out.set(key, toInt(record.get(key)) ?? 0);
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
  const [
    release,
    artist,
    track,
    master,
    natArtist,
    natMusician,
    natProducer,
    natEngineer,
    musician,
    memberOf,
  ] = await Promise.all([
    runCounts(driver, RELEASE_QUERY),
    runCounts(driver, ARTIST_QUERY),
    runCounts(driver, TRACK_QUERY),
    runCounts(driver, MASTER_QUERY),
    runCounts(driver, ARTIST_NATIONALITY_QUERY),
    runCounts(driver, MUSICIAN_NATIONALITY_QUERY),
    runCounts(driver, PRODUCER_NATIONALITY_QUERY),
    runCounts(driver, ENGINEER_NATIONALITY_QUERY),
    runCounts(driver, MUSICIAN_QUERY),
    runCounts(driver, MEMBER_OF_QUERY),
  ]);

  const n = (m: Map<string, number>, key: string): number => m.get(key) ?? 0;

  const trackTotal = n(track, 'total');
  const mbidCovered = n(track, 'mbidCovered');
  const isrcCovered = n(track, 'isrcCovered');

  // Lyrics funnel (#246, #248). `resolved` keys on `lyrics IS NOT NULL` (ground truth) so legacy
  // tracks enriched before `lyricsStatus` existed still count; the two instrumental buckets
  // are believed lyric-less, so they leave the honest non-instrumental coverage denominator.
  // `lowConfidence` stays IN that denominator — a track that *could* have lyrics, just not
  // confidently matched yet (like `notFound`); excluding it would inflate coverage by hiding
  // failures. Each `lyrics IS NULL` bucket requires a distinct status (see TRACK_QUERY) so a track
  // with dirty/manual data (lyrics set AND a non-resolved status, which our writers never produce
  // — there is no DB constraint) is counted only as `resolved`, keeping the buckets disjoint and
  // the derived `notFound` non-negative.
  const lyricsCovered = n(track, 'lyricsCovered');
  const lyricsInstrumental = n(track, 'lyricsInstrumental');
  const lyricsProbableInstrumental = n(track, 'lyricsProbableInstrumental');
  const lyricsLowConfidence = n(track, 'lyricsLowConfidence');
  const nonInstrumentalTracks = trackTotal - lyricsInstrumental - lyricsProbableInstrumental;
  const lyricsNotFound =
    trackTotal -
    lyricsCovered -
    lyricsInstrumental -
    lyricsProbableInstrumental -
    lyricsLowConfidence;

  const nationality = (m: Map<string, number>): SourcedCoverageMetric =>
    sourced(n(m, 'covered'), n(m, 'applicable'), {
      musicbrainz: n(m, 'mb'),
      wikidata: n(m, 'wikidata'),
    });

  return {
    counts: {
      releases: n(release, 'total'),
      artists: n(artist, 'total'),
      tracks: trackTotal,
      masters: n(master, 'total'),
      musicians: n(musician, 'total'),
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
      // Honest coverage: covered over tracks that *could* have lyrics (excludes the two
      // instrumental classes). covered stays the ground-truth lyrics count (#246).
      tracksWithLyrics: sourced(lyricsCovered, nonInstrumentalTracks, {
        lrclib: n(track, 'lyricsLrclibCovered'),
        genius: n(track, 'lyricsGeniusCovered'),
      }),
      lyricsFunnel: {
        resolved: lyricsCovered,
        instrumental: lyricsInstrumental,
        probableInstrumental: lyricsProbableInstrumental,
        lowConfidence: lyricsLowConfidence,
        notFound: lyricsNotFound,
        total: trackTotal,
      },
      tracksWithRecordingMbid: coverage(mbidCovered, trackTotal),
      tracksWithIsrc: coverage(isrcCovered, trackTotal),
      // Applicable denominators are the upstream gates: tempo needs a recordingMbid,
      // deezerBpm/deezerGain need an isrc (both produced by track-musicbrainz enrichment).
      tracksWithTempo: coverage(n(track, 'tempoCovered'), mbidCovered),
      tracksWithDeezerBpm: coverage(n(track, 'deezerCovered'), isrcCovered),
      tracksWithDeezerGain: coverage(n(track, 'deezerGainCovered'), isrcCovered),
      mastersWithReleaseEvents: coverage(n(master, 'releaseEventsCovered'), n(master, 'total')),
      samePersonLinks: coverage(
        n(musician, 'samePersonCovered'),
        n(musician, 'samePersonApplicable'),
      ),
      memberOfEdges: n(memberOf, 'memberOfEdges'),
      groupsWithMembers: n(musician, 'groupsWithMembers'),
    },
  };
}
