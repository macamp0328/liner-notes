import neo4j, { Driver } from 'neo4j-driver';
import type { RoleCategory } from '../../ingestion/transforms.js';
import { toInt, toStr, toFloat } from '../coercions.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ExploreRelease {
  discogsId: number;
  title: string;
  artist: string | null;
  pressingYear: number | null;
  format: string | null;
  thumbUrl: string | null;
}

export interface MusicianRelease extends ExploreRelease {
  instrument: string | null;
  role: string | null;
}

export interface ConnectionNode {
  type: string;
  discogsId: number | null;
  name: string | null;
  title: string | null;
}

export interface ConnectionsResult {
  seed: ExploreRelease;
  nodes: ConnectionNode[];
}

export interface SharedMusician {
  name: string;
  instrument: string | null;
}

export interface SharedMusiciansResult {
  releaseA: { discogsId: number; title: string };
  releaseB: { discogsId: number; title: string };
  sharedMusicians: SharedMusician[];
}

export interface InternationalTrack {
  trackTitle: string;
  albumTitle: string;
  releaseDiscogsId: number;
  countryCount: number;
  countries: string[];
}

export interface MostPressedRelease {
  albumTitle: string;
  masterDiscogsId: number;
  countryCount: number;
  countries: string[];
}

function mapExploreRelease(record: { get: (key: string) => unknown }): ExploreRelease {
  return {
    discogsId: toInt(record.get('discogsId')) ?? 0,
    title: toStr(record.get('title')) ?? '',
    artist: toStr(record.get('artist')),
    pressingYear: toInt(record.get('pressingYear')),
    format: toStr(record.get('format')),
    thumbUrl: toStr(record.get('thumbUrl')),
  };
}

// ---------------------------------------------------------------------------
// getReleasesByMusician
// ---------------------------------------------------------------------------

export async function getReleasesByMusician(
  driver: Driver,
  name: string,
): Promise<MusicianRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c:CREDITED_ON]->(r:Release)
      WHERE toLower(m.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl,
             c.displayRole AS instrument, c.roleCategory AS role
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map((rec) => ({
      ...mapExploreRelease(rec),
      instrument: toStr(rec.get('instrument')),
      role: toStr(rec.get('role')),
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByCredit
// ---------------------------------------------------------------------------

/**
 * Releases where this person is credited in a specific role category (e.g.
 * 'producer', 'engineer'). Same shape as getReleasesByMusician — producers and
 * engineers are Musician nodes too — but filtered by CREDITED_ON.roleCategory,
 * which is exactly what parseRoleCategory() tags each credit with at ingest.
 */
export async function getReleasesByCredit(
  driver: Driver,
  name: string,
  roleCategory: RoleCategory,
): Promise<MusicianRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c:CREDITED_ON]->(r:Release)
      WHERE toLower(m.name) = toLower($name) AND c.roleCategory = $roleCategory
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl,
             c.displayRole AS instrument, c.roleCategory AS role
      ORDER BY pressingYear
      `,
      { name, roleCategory },
    );
    return result.records.map((rec) => ({
      ...mapExploreRelease(rec),
      instrument: toStr(rec.get('instrument')),
      role: toStr(rec.get('role')),
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByStudio
// ---------------------------------------------------------------------------

export async function getReleasesByStudio(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:RECORDED_AT]->(s:Studio)
      WHERE toLower(s.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByLabel
// ---------------------------------------------------------------------------

export async function getReleasesByLabel(
  driver: Driver,
  name: string,
  includeSublabels = false,
): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    // Only the match that binds the release set `r` varies between the two modes; the
    // OPTIONAL MATCH + projection + ordering tail is shared so a future projection change
    // touches one place. includeSublabels rolls up the whole label family — the named label
    // plus every label connected through PARENT_LABEL in either direction (parent, ancestors,
    // and their sublabels), bounded to a shallow depth — and adds DISTINCT, which is then
    // load-bearing: a release on two family labels, or multiple same-name seeds, would
    // otherwise duplicate (issue #332).
    const match = includeSublabels
      ? `MATCH (seed:Label) WHERE toLower(seed.name) = toLower($name)
         MATCH (fam:Label) WHERE fam = seed OR (fam)-[:PARENT_LABEL*1..4]-(seed)
         MATCH (r:Release)-[:ON_LABEL]->(fam)`
      : `MATCH (r:Release)-[:ON_LABEL]->(l:Label)
         WHERE toLower(l.name) = toLower($name)`;
    const result = await session.run(
      `
      ${match}
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN ${includeSublabels ? 'DISTINCT ' : ''}r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByGenre
// ---------------------------------------------------------------------------

export async function getReleasesByGenre(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:IN_GENRE]->(g:Genre)
      WHERE toLower(g.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByStyle
// ---------------------------------------------------------------------------

export async function getReleasesByStyle(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:IN_STYLE]->(s:Style)
      WHERE toLower(s.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByCountry
// ---------------------------------------------------------------------------

export async function getReleasesByCountry(
  driver: Driver,
  name: string,
): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:FROM_COUNTRY]->(c:Country)
      WHERE toLower(c.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByDecade
// ---------------------------------------------------------------------------

export async function getReleasesByDecade(
  driver: Driver,
  decade: string,
): Promise<ExploreRelease[]> {
  const startYear = neo4j.int(parseInt(decade.slice(0, 4), 10));
  const endYear = neo4j.int(parseInt(decade.slice(0, 4), 10) + 10);
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)
      WHERE coalesce(r.originalYear, r.pressingYear) >= $startYear
        AND coalesce(r.originalYear, r.pressingYear) < $endYear
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { startYear, endYear },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByYear
// ---------------------------------------------------------------------------

export async function getReleasesByYear(driver: Driver, year: number): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)
      WHERE coalesce(r.originalYear, r.pressingYear) = $year
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY r.title
      `,
      { year: neo4j.int(year) },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getConnections
// Depth is a validated literal (1 | 2 | 3), so interpolating it into Cypher is
// safe today. We still coerce it to an integer in [1, 3] at runtime as defense-in-
// depth — the type/schema/cast gates live at the call site, so a future caller (or a
// widened signature) can't turn this into an unbounded traversal or interpolate a
// non-integer/NaN (`*1..2.5` / `*1..NaN`) that Cypher would reject at runtime.
// ---------------------------------------------------------------------------

export async function getConnections(
  driver: Driver,
  discogsId: number,
  depth: 1 | 2 | 3,
): Promise<ConnectionsResult | null> {
  const rounded = Math.round(depth);
  const safeDepth = Number.isFinite(rounded) ? Math.min(3, Math.max(1, rounded)) : 1;
  const session = driver.session();
  try {
    const query = `
      MATCH (start:Release {discogsId: $discogsId})
      OPTIONAL MATCH (start)-[:RELEASED_BY]->(sa:Artist)
      OPTIONAL MATCH (start)-[*1..${safeDepth}]-(connected)
        WHERE (connected:Release OR connected:Artist OR connected:Musician OR connected:Studio)
          AND connected <> start
      WITH start, sa, connected WHERE connected IS NOT NULL
      WITH DISTINCT start, sa, connected
      LIMIT 200
      WITH start, sa, collect({
             type: head(labels(connected)),
             discogsId: connected.discogsId,
             name: connected.name,
             title: connected.title
           }) AS nodes
      RETURN start.discogsId AS discogsId, start.title AS title, sa.name AS artist,
             coalesce(start.originalYear, start.pressingYear) AS pressingYear,
             start.format AS format, start.thumbUrl AS thumbUrl,
             nodes
    `;
    const result = await session.run(query, { discogsId: neo4j.int(discogsId) });
    if (result.records.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rec = result.records[0]!;
    const seed: ExploreRelease = {
      discogsId: toInt(rec.get('discogsId')) ?? 0,
      title: toStr(rec.get('title')) ?? '',
      artist: toStr(rec.get('artist')),
      pressingYear: toInt(rec.get('pressingYear')),
      format: toStr(rec.get('format')),
      thumbUrl: toStr(rec.get('thumbUrl')),
    };
    const rawNodes = rec.get('nodes') as Array<{
      type: unknown;
      discogsId: unknown;
      name: unknown;
      title: unknown;
    }>;
    const nodes: ConnectionNode[] = rawNodes
      .filter((n) => n.type !== null)
      .map((n) => ({
        type: toStr(n.type) ?? '',
        discogsId: toInt(n.discogsId),
        name: toStr(n.name),
        title: toStr(n.title),
      }));
    return { seed, nodes };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getMostInternationalTracks
// ---------------------------------------------------------------------------

export async function getMostInternationalTracks(
  driver: Driver,
  limit: number,
): Promise<InternationalTrack[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
      MATCH (m:Musician)-[co:CREDITED_ON]->(t)
      MATCH (m)-[:ORIGIN_COUNTRY]->(c:Country)
      WHERE co.roleCategory IN ['performer', 'composer']
      WITH t, r, collect(DISTINCT c.name) AS countries
      WHERE size(countries) > 1
      RETURN t.title AS trackTitle, r.title AS albumTitle,
             r.discogsId AS releaseDiscogsId,
             size(countries) AS countryCount, countries
      ORDER BY countryCount DESC, trackTitle
      LIMIT $limit
      `,
      { limit: neo4j.int(limit) },
    );
    return result.records.map((rec) => ({
      trackTitle: toStr(rec.get('trackTitle')) ?? '',
      albumTitle: toStr(rec.get('albumTitle')) ?? '',
      releaseDiscogsId: toInt(rec.get('releaseDiscogsId')) ?? 0,
      countryCount: toInt(rec.get('countryCount')) ?? 0,
      countries: (rec.get('countries') as string[]) ?? [],
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getMostPressedReleases
// ---------------------------------------------------------------------------

export async function getMostPressedReleases(
  driver: Driver,
  limit: number,
): Promise<MostPressedRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Master)-[:RELEASED_IN]->(c:Country)
      WITH m.discogsId AS masterDiscogsId, m.title AS albumTitle,
           collect(DISTINCT c.name) AS countries
      WHERE size(countries) > 1
      RETURN masterDiscogsId, albumTitle, size(countries) AS countryCount, countries
      ORDER BY countryCount DESC, albumTitle
      LIMIT $limit
      `,
      { limit: neo4j.int(limit) },
    );
    return result.records.map((rec) => ({
      albumTitle: toStr(rec.get('albumTitle')) ?? '',
      masterDiscogsId: toInt(rec.get('masterDiscogsId')) ?? 0,
      countryCount: toInt(rec.get('countryCount')) ?? 0,
      countries: (rec.get('countries') as string[]) ?? [],
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getSharedMusicians
// ---------------------------------------------------------------------------

export async function getSharedMusicians(driver: Driver): Promise<SharedMusiciansResult[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c1:CREDITED_ON]->(r1:Release),
            (m)-[:CREDITED_ON]->(r2:Release)
      WHERE r1.discogsId < r2.discogsId
      WITH r1, r2, collect(DISTINCT {name: m.name, instrument: c1.displayRole}) AS sharedMusicians
      WHERE size(sharedMusicians) > 0
      RETURN r1.discogsId AS releaseAId, r1.title AS releaseATitle,
             r2.discogsId AS releaseBId, r2.title AS releaseBTitle,
             sharedMusicians
      LIMIT 200
      `,
    );
    return result.records.map((rec) => {
      const rawMusicians = rec.get('sharedMusicians') as Array<{
        name: unknown;
        instrument: unknown;
      }>;
      return {
        releaseA: {
          discogsId: toInt(rec.get('releaseAId')) ?? 0,
          title: toStr(rec.get('releaseATitle')) ?? '',
        },
        releaseB: {
          discogsId: toInt(rec.get('releaseBId')) ?? 0,
          title: toStr(rec.get('releaseBTitle')) ?? '',
        },
        sharedMusicians: rawMusicians.map((m) => ({
          name: toStr(m.name) ?? '',
          instrument: toStr(m.instrument),
        })),
      };
    });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getTracksByAudioFeatures
// ---------------------------------------------------------------------------

export interface AudioFeatureTrack {
  trackTitle: string;
  releaseTitle: string;
  releaseDiscogsId: number;
  tempo: number | null;
  musicalKey: string | null;
  musicalScale: string | null;
  loudnessDb: number | null;
  danceabilityEstimate: number | null;
  voiceInstrumental: string | null;
  deezerBpm: number | null;
  deezerGain: number | null;
}

export interface AudioFeatureFilters {
  minTempo?: number;
  maxTempo?: number;
  key?: string;
  scale?: string;
  voiceInstrumental?: string;
  minDanceability?: number;
}

export async function getTracksByAudioFeatures(
  driver: Driver,
  filters: AudioFeatureFilters,
  limit: number,
): Promise<AudioFeatureTrack[]> {
  const conditions: string[] = ['(t.tempo IS NOT NULL OR t.deezerBpm IS NOT NULL)'];
  const params: Record<string, unknown> = { limit: neo4j.int(limit) };

  if (filters.minTempo !== undefined && filters.maxTempo !== undefined) {
    // Both bounds: at least one source must be fully within the range.
    conditions.push(
      '((t.tempo >= $minTempo AND t.tempo <= $maxTempo) OR (t.deezerBpm >= $minTempo AND t.deezerBpm <= $maxTempo))',
    );
    params['minTempo'] = filters.minTempo;
    params['maxTempo'] = filters.maxTempo;
  } else if (filters.minTempo !== undefined) {
    conditions.push('(t.tempo >= $minTempo OR t.deezerBpm >= $minTempo)');
    params['minTempo'] = filters.minTempo;
  } else if (filters.maxTempo !== undefined) {
    conditions.push('(t.tempo <= $maxTempo OR t.deezerBpm <= $maxTempo)');
    params['maxTempo'] = filters.maxTempo;
  }
  if (filters.key !== undefined) {
    conditions.push('t.musicalKey = $key');
    params['key'] = filters.key;
  }
  if (filters.scale !== undefined) {
    conditions.push('t.musicalScale = $scale');
    params['scale'] = filters.scale;
  }
  if (filters.voiceInstrumental !== undefined) {
    conditions.push('t.voiceInstrumental = $voiceInstrumental');
    params['voiceInstrumental'] = filters.voiceInstrumental;
  }
  if (filters.minDanceability !== undefined) {
    conditions.push('t.danceabilityEstimate >= $minDanceability');
    params['minDanceability'] = filters.minDanceability;
  }

  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
       WHERE ${conditions.join(' AND ')}
       RETURN t.title AS trackTitle, r.title AS releaseTitle,
              r.discogsId AS releaseDiscogsId,
              t.tempo AS tempo, t.musicalKey AS musicalKey,
              t.musicalScale AS musicalScale, t.loudnessDb AS loudnessDb,
              t.danceabilityEstimate AS danceabilityEstimate,
              t.voiceInstrumental AS voiceInstrumental,
              t.deezerBpm AS deezerBpm, t.deezerGain AS deezerGain
       ORDER BY coalesce(t.tempo, t.deezerBpm) ASC, trackTitle
       LIMIT $limit`,
      params,
    );
    return result.records.map((rec) => ({
      trackTitle: toStr(rec.get('trackTitle')) ?? '',
      releaseTitle: toStr(rec.get('releaseTitle')) ?? '',
      releaseDiscogsId: toInt(rec.get('releaseDiscogsId')) ?? 0,
      tempo: toFloat(rec.get('tempo')),
      musicalKey: toStr(rec.get('musicalKey')),
      musicalScale: toStr(rec.get('musicalScale')),
      loudnessDb: toFloat(rec.get('loudnessDb')),
      danceabilityEstimate: toFloat(rec.get('danceabilityEstimate')),
      voiceInstrumental: toStr(rec.get('voiceInstrumental')),
      deezerBpm: toFloat(rec.get('deezerBpm')),
      deezerGain: toFloat(rec.get('deezerGain')),
    }));
  } finally {
    await session.close();
  }
}
