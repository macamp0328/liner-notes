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

export interface InstrumentCredit extends ExploreRelease {
  musician: string;
  instrument: string | null;
  displayRole: string | null;
  scope: string | null;
}

/**
 * A person-level player of an instrument (#393): an Artist whose Wikidata P1303 set, normalized onto
 * the #333 family vocabulary, includes the queried family. Distinct from {@link InstrumentCredit},
 * which is the per-credit axis (someone credited on a release/track playing the instrument).
 * `playsInstrument` is the artist's full normalized family list, so the caller can show "also plays".
 */
export interface InstrumentPlayer {
  discogsId: number;
  name: string;
  playsInstrument: string[];
}

/**
 * One recording of a Work in the collection (#336). Rows sharing a `recordingMbid` are the same
 * recording on multiple releases (a duplicate); distinct `recordingMbid` values under one Work are
 * different recordings — the versions/covers.
 */
export interface WorkRecording {
  workTitle: string;
  recordingMbid: string;
  trackTitle: string;
  position: string | null;
  discogsId: number;
  releaseTitle: string;
  artist: string | null;
  year: number | null;
  thumbUrl: string | null;
}

/**
 * One in-collection recording of a Work written by a given person (#380). Flat like
 * {@link WorkRecording} — one row per recording — plus the composition (`workMbid`/`workTitle`) and
 * the writer's `roles` on that Work (e.g. `["composer", "lyricist"]`). Multiple rows share a
 * `workMbid` when several recordings of the same composition are owned.
 */
export interface SongwriterWork {
  workMbid: string;
  workTitle: string;
  roles: string[];
  recordingMbid: string;
  trackTitle: string;
  position: string | null;
  discogsId: number;
  releaseTitle: string;
  artist: string | null;
  year: number | null;
  thumbUrl: string | null;
}

/**
 * One end of an in-collection influence relationship (#391): an Artist the queried person influenced
 * or was influenced by, both keyed on the Wikidata QID join. `wikidataQid` is the QID the
 * `INFLUENCED_BY` edge resolved on (always present — the edge can't exist without it).
 */
export interface InfluenceArtist {
  discogsId: number;
  name: string;
  wikidataQid: string;
}

/**
 * The two-directional influence neighbourhood of one Artist (#391): `influencedBy` are the artists
 * the named person was influenced by (outgoing P737 edges), `influenced` are the artists they
 * influenced (incoming edges). Both are empty for an unknown name or one with no INFLUENCED_BY edges.
 */
export interface ArtistInfluences {
  influencedBy: InfluenceArtist[];
  influenced: InfluenceArtist[];
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

/**
 * One pin on the recording-location map (#342): a Studio whose MusicBrainz Place coordinates are known
 * (#339 slice 2). `releaseCount`/`trackCount` size the marker — `releaseCount` rolls track-level MB
 * studio edges up to their Release (like {@link getReleasesByStudio}), `trackCount` is the distinct
 * track-level edges. Studios without coordinates are excluded — an honest map has no pin for an
 * unplaced studio. `latitude`/`longitude` are always present (the query filters on them).
 */
export interface RecordingLocation {
  name: string;
  latitude: number;
  longitude: number;
  area: string | null;
  musicbrainzPlaceId: string | null;
  releaseCount: number;
  trackCount: number;
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

/**
 * Releases a person worked on, resolving entity-resolution edges (#330). The query name is
 * resolved to a *set* of Musician nodes via the CALL{} below:
 *   - the directly-named node, and the canonical name via SAME_PERSON_AS (so an alias and the
 *     Artist's canonical name return the same set) + its alias siblings — pure accuracy, same person.
 *   - the groups a queried *member* belongs to (MEMBER_OF, member→group): a member's results
 *     additionally include their group's records — an INFERRED, temporally-unguarded involvement
 *     (the group's catalog, not necessarily records the person personally played on; date-qualified
 *     membership is roadmapped #339/#341). The reverse (group→members) is deliberately NOT expanded:
 *     it would attribute every member's unrelated solo credit to the group, making the group look
 *     involved in records it never touched (PR #330 review). A group query therefore returns only
 *     the group's own credits; the MEMBER_OF edges still exist and are surfaced via /stats.
 * Then returns their CREDITED_ON releases incl. track-scoped credits (track→release via HAS_TRACK),
 * deduped by release, with one representative artist/instrument/role per release.
 */
export async function getReleasesByMusician(
  driver: Driver,
  name: string,
): Promise<MusicianRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (seed:Musician)
      WHERE toLower(seed.name) = toLower($name)
         OR EXISTS { MATCH (seed)-[:SAME_PERSON_AS]->(a:Artist) WHERE toLower(a.name) = toLower($name) }
      WITH collect(DISTINCT seed) AS seeds
      UNWIND seeds AS s
      CALL {
        WITH s RETURN s AS person
        UNION WITH s MATCH (s)-[:SAME_PERSON_AS]->(:Artist)<-[:SAME_PERSON_AS]-(sib:Musician) RETURN sib AS person
        UNION WITH s MATCH (s)-[:MEMBER_OF]->(grp:Musician) RETURN grp AS person
      }
      WITH DISTINCT person
      MATCH (person)-[c:CREDITED_ON]->(target)
      WHERE target:Release OR target:Track
      OPTIONAL MATCH (rTrack:Release)-[:HAS_TRACK]->(target)
      WITH (CASE WHEN target:Release THEN target ELSE rTrack END) AS r, c
      WHERE r IS NOT NULL
      // Pick ONE representative credit per release so instrument + role come from the SAME edge
      // (independent min() could pair an instrument from one credit with a role from another).
      WITH r, c ORDER BY c.displayRole, c.roleCategory
      WITH r, head(collect({instrument: c.displayRole, role: c.roleCategory})) AS credit
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      WITH r, credit, min(a.name) AS artist
      RETURN r.discogsId AS discogsId, r.title AS title, artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl,
             credit.instrument AS instrument, credit.role AS role
      ORDER BY pressingYear, discogsId
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
 * 'producer', 'engineer'), filtered by CREDITED_ON.roleCategory — exactly what
 * parseRoleCategory() tags each credit with at ingest. Includes both release-scoped
 * credits AND track-scoped ones (track→release via HAS_TRACK), deduped per release,
 * mirroring getReleasesByMusician: MusicBrainz pushes producer/engineer credits down
 * to the Track (#339), so a release-only match would miss them.
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
      MATCH (m:Musician)-[c:CREDITED_ON]->(target)
      WHERE toLower(m.name) = toLower($name)
        AND c.roleCategory = $roleCategory
        AND (target:Release OR target:Track)
      OPTIONAL MATCH (rTrack:Release)-[:HAS_TRACK]->(target)
      WITH (CASE WHEN target:Release THEN target ELSE rTrack END) AS r, c
      WHERE r IS NOT NULL
      // One representative credit per release so displayRole + roleCategory come from the SAME edge.
      WITH r, c ORDER BY c.displayRole, c.roleCategory
      WITH r, head(collect({instrument: c.displayRole, role: c.roleCategory})) AS credit
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      WITH r, credit, min(a.name) AS artist
      RETURN r.discogsId AS discogsId, r.title AS title, artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl,
             credit.instrument AS instrument, credit.role AS role
      ORDER BY pressingYear, discogsId
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
// getReleasesByInstrument
// ---------------------------------------------------------------------------

/**
 * Who plays a given instrument family in the collection, and on which releases.
 * Filters CREDITED_ON.instrument — the normalized, derived value parseInstrument()
 * tags each credit with at ingest — so one query answers "who plays bass" without
 * enumerating every Discogs spelling. The verbatim displayRole is returned per row
 * so the caller still sees the specific credit (e.g. "Upright Bass").
 *
 * The param is lowercased to match the canonical stored family; stored values are
 * always lowercase, so the equality also excludes the many null-instrument credits.
 * v1 is release-scoped (Musician → Release), mirroring producer/engineer; track-scope
 * credits are a deliberate follow-up.
 */
export async function getReleasesByInstrument(
  driver: Driver,
  instrument: string,
): Promise<InstrumentCredit[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c:CREDITED_ON]->(r:Release)
      WHERE c.instrument = toLower($instrument)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl,
             m.name AS musician, c.instrument AS instrument,
             c.displayRole AS displayRole, c.scope AS scope
      ORDER BY musician, pressingYear
      `,
      { instrument },
    );
    return result.records.map((rec) => ({
      ...mapExploreRelease(rec),
      musician: toStr(rec.get('musician')) ?? '',
      instrument: toStr(rec.get('instrument')),
      displayRole: toStr(rec.get('displayRole')),
      scope: toStr(rec.get('scope')),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Person-level players of an instrument family (#393): Artists whose Wikidata P1303 set (normalized
 * onto the #333 vocabulary and stored on `Artist.playsInstrument`) contains the queried family. The
 * companion to {@link getReleasesByInstrument} — together they answer "who plays bass" from both the
 * documented person-level axis (Wikidata) and the per-credit axis (Discogs/MB credits). The stored
 * families are lowercase, so the param is lowercased to match; that also excludes artists with no
 * (or an empty) `playsInstrument`.
 */
export async function getArtistsByPersonLevelInstrument(
  driver: Driver,
  instrument: string,
): Promise<InstrumentPlayer[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:Artist)
      WHERE a.discogsId IS NOT NULL AND toLower($instrument) IN a.playsInstrument
      RETURN a.discogsId AS discogsId, a.name AS name, a.playsInstrument AS playsInstrument
      ORDER BY name
      `,
      { instrument },
    );
    return result.records.map((rec) => ({
      discogsId: toInt(rec.get('discogsId')) ?? 0,
      name: toStr(rec.get('name')) ?? '',
      playsInstrument: (rec.get('playsInstrument') as string[] | null) ?? [],
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getRecordingsByWork
// ---------------------------------------------------------------------------

/**
 * Every recording of a Work in the collection — "every version of this song I own" (#336).
 * Grouping is purely on the shared Work MBID (ground truth from MusicBrainz), so a title
 * collision can never group two different compositions, and a genuine cover (a different
 * recording of the same Work) is grouped even when titles differ. Each row carries its
 * `recordingMbid` so the caller can tell distinct recordings (versions/covers) apart from the
 * same recording reissued on another release (a duplicate). Returns an empty array for an
 * unknown or unlinked Work MBID.
 */
export async function getRecordingsByWork(driver: Driver, mbid: string): Promise<WorkRecording[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (t:Track)-[:RECORDING_OF]->(w:Work {mbid: $mbid})
      MATCH (r:Release)-[:HAS_TRACK]->(t)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN w.title AS workTitle, t.recordingMbid AS recordingMbid,
             t.title AS trackTitle, t.position AS position,
             r.discogsId AS discogsId, r.title AS releaseTitle, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS year, r.thumbUrl AS thumbUrl
      ORDER BY recordingMbid, year, discogsId
      `,
      { mbid },
    );
    return result.records.map((rec) => ({
      workTitle: toStr(rec.get('workTitle')) ?? '',
      recordingMbid: toStr(rec.get('recordingMbid')) ?? '',
      trackTitle: toStr(rec.get('trackTitle')) ?? '',
      position: toStr(rec.get('position')),
      discogsId: toInt(rec.get('discogsId')) ?? 0,
      releaseTitle: toStr(rec.get('releaseTitle')) ?? '',
      artist: toStr(rec.get('artist')),
      year: toInt(rec.get('year')),
      thumbUrl: toStr(rec.get('thumbUrl')),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Every in-collection recording of a composition written by `name` (#380), via the WROTE edges the
 * songwriter-reconciliation pass created from each Work's MusicBrainz writer MBIDs. Matches the
 * writer across BOTH person labels (a songwriter can be a primary `Artist` and/or a session
 * `Musician`), case-insensitively by name. `DISTINCT` collapses the duplicate row a SAME_PERSON_AS
 * pair would otherwise produce (both nodes carry the same MBID → same WROTE roles). Returns an empty
 * array for an unknown name or one with no WROTE edges.
 */
export async function getWorksBySongwriter(
  driver: Driver,
  name: string,
): Promise<SongwriterWork[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (p)-[wr:WROTE]->(w:Work)
      WHERE (p:Artist OR p:Musician) AND toLower(p.name) = toLower($name)
      MATCH (t:Track)-[:RECORDING_OF]->(w)
      MATCH (r:Release)-[:HAS_TRACK]->(t)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN DISTINCT w.mbid AS workMbid, w.title AS workTitle, wr.roles AS roles,
             t.recordingMbid AS recordingMbid, t.title AS trackTitle, t.position AS position,
             r.discogsId AS discogsId, r.title AS releaseTitle, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS year, r.thumbUrl AS thumbUrl
      ORDER BY workTitle, year, discogsId
      `,
      { name },
    );
    return result.records.map((rec) => ({
      workMbid: toStr(rec.get('workMbid')) ?? '',
      workTitle: toStr(rec.get('workTitle')) ?? '',
      roles: ((rec.get('roles') as unknown[] | null) ?? []).map((r) => String(r)),
      recordingMbid: toStr(rec.get('recordingMbid')) ?? '',
      trackTitle: toStr(rec.get('trackTitle')) ?? '',
      position: toStr(rec.get('position')),
      discogsId: toInt(rec.get('discogsId')) ?? 0,
      releaseTitle: toStr(rec.get('releaseTitle')) ?? '',
      artist: toStr(rec.get('artist')),
      year: toInt(rec.get('year')),
      thumbUrl: toStr(rec.get('thumbUrl')),
    }));
  } finally {
    await session.close();
  }
}

/**
 * The two-directional Wikidata-P737 influence neighbourhood of an Artist (#391), matched
 * case-insensitively by name. `influencedBy` traverses outgoing `INFLUENCED_BY` (who this person was
 * influenced by); `influenced` traverses incoming (who they influenced). Only in-collection artists
 * appear — the edges only ever link two Artist nodes that share the QID join. Returns empty arrays
 * for an unknown name or one with no influence edges.
 *
 * `Artist.name` is not unique (two distinct Discogs artists can share a name), so both directions are
 * aggregated with a single grouping-key-free `collect` that runs AFTER both OPTIONAL MATCHes — this
 * unions every matched node's neighbours into one row. A per-node `WITH a, collect(...)` would split
 * the result by node and the later regrouping would silently return only one node's slice. Each
 * `collect(DISTINCT …)` dedupes both the OPTIONAL-MATCH cross-product and any overlap across roots.
 */
export async function getArtistInfluences(driver: Driver, name: string): Promise<ArtistInfluences> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:Artist) WHERE toLower(a.name) = toLower($name)
      OPTIONAL MATCH (a)-[:INFLUENCED_BY]->(src:Artist)
      OPTIONAL MATCH (a)<-[:INFLUENCED_BY]-(dst:Artist)
      WITH collect(DISTINCT src) AS influencedBy, collect(DISTINCT dst) AS influenced
      RETURN
        [x IN influencedBy | { discogsId: x.discogsId, name: x.name, wikidataQid: x.wikidataQid }] AS influencedBy,
        [x IN influenced | { discogsId: x.discogsId, name: x.name, wikidataQid: x.wikidataQid }] AS influenced
      `,
      { name },
    );
    const record = result.records[0];
    const mapList = (raw: unknown): InfluenceArtist[] =>
      ((raw as Array<Record<string, unknown>> | null) ?? []).map((x) => ({
        discogsId: toInt(x['discogsId']) ?? 0,
        name: toStr(x['name']) ?? '',
        wikidataQid: toStr(x['wikidataQid']) ?? '',
      }));
    return {
      influencedBy: record ? mapList(record.get('influencedBy')) : [],
      influenced: record ? mapList(record.get('influenced')) : [],
    };
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
    // A studio is credited at BOTH levels: album-level via Discogs `(:Release)-[:RECORDED_AT]->`,
    // and track-level via MusicBrainz `(:Track)-[:RECORDED_AT {source:'musicbrainz'}]->` (#339 slice
    // 2). Roll the track edges up to their Release (track→release via HAS_TRACK) and DISTINCT per
    // release, mirroring getReleasesByCredit — so a release whose *track* was recorded at the studio
    // surfaces even when its album-level credit didn't name it, without duplicate rows.
    const result = await session.run(
      `
      MATCH (target)-[:RECORDED_AT]->(s:Studio)
      WHERE toLower(s.name) = toLower($name)
        AND (target:Release OR target:Track)
      OPTIONAL MATCH (rTrack:Release)-[:HAS_TRACK]->(target)
      WITH DISTINCT (CASE WHEN target:Release THEN target ELSE rTrack END) AS r
      WHERE r IS NOT NULL
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      WITH r, min(a.name) AS artist
      RETURN r.discogsId AS discogsId, r.title AS title, artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear, discogsId
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getRecordingLocations
// ---------------------------------------------------------------------------

/**
 * Every Studio with known coordinates, for the recording-location map (#342). The coordinates come from
 * MusicBrainz Place data (#339 slice 2) — deterministic, never geocoded from ambiguous free-text — so a
 * studio with no confident location simply has no pin. Per-studio `releaseCount` rolls track-level MB
 * `RECORDED_AT` edges up to their Release via `HAS_TRACK` (mirroring {@link getReleasesByStudio}), so a
 * studio attributed only at the track level still counts its album; `trackCount` is the distinct
 * track-level edges. The filter is coordinates-only, not edge-count: a `/track-recording-places/reset`
 * leaves Studio coordinates intact, so a (temporarily) edgeless studio still pins with `releaseCount: 0`.
 */
export async function getRecordingLocations(driver: Driver): Promise<RecordingLocation[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (s:Studio)
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      OPTIONAL MATCH (target)-[:RECORDED_AT]->(s)
        WHERE target:Release OR target:Track
      OPTIONAL MATCH (rTrack:Release)-[:HAS_TRACK]->(target)
      WITH s,
           collect(DISTINCT CASE WHEN target:Release THEN target
                                 WHEN target:Track   THEN rTrack END) AS releases,
           count(DISTINCT CASE WHEN target:Track THEN target END) AS trackCount
      RETURN s.name AS name, s.latitude AS latitude, s.longitude AS longitude,
             s.area AS area, s.musicbrainzPlaceId AS musicbrainzPlaceId,
             size([r IN releases WHERE r IS NOT NULL]) AS releaseCount,
             trackCount
      ORDER BY releaseCount DESC, name
      `,
    );
    return result.records.map((record) => ({
      name: toStr(record.get('name')) ?? '',
      // The WHERE filter guarantees both are present; the ?? 0 only satisfies the non-null type.
      latitude: toFloat(record.get('latitude')) ?? 0,
      longitude: toFloat(record.get('longitude')) ?? 0,
      area: toStr(record.get('area')),
      musicbrainzPlaceId: toStr(record.get('musicbrainzPlaceId')),
      releaseCount: toInt(record.get('releaseCount')) ?? 0,
      trackCount: toInt(record.get('trackCount')) ?? 0,
    }));
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

/**
 * Release pairs that share a session person, collapsing SAME_PERSON_AS aliases so one person counts
 * once across their alias nodes (#330). Each credit is resolved to a canonical identity key
 * (Artist.discogsId via SAME_PERSON_AS, else the Musician's own discogsId, else its name) and
 * includes track-scoped credits (track→release via HAS_TRACK), consistent with getReleasesByMusician.
 */
export async function getSharedMusicians(driver: Driver): Promise<SharedMusiciansResult[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c:CREDITED_ON]->(target)
      WHERE target:Release OR target:Track
      OPTIONAL MATCH (rt:Release)-[:HAS_TRACK]->(target)
      WITH m, c, (CASE WHEN target:Release THEN target ELSE rt END) AS r
      WHERE r IS NOT NULL
      OPTIONAL MATCH (m)-[:SAME_PERSON_AS]->(a:Artist)
      WITH r, c,
           coalesce(toString(a.discogsId), toString(m.discogsId), 'name:' + m.name) AS personKey,
           coalesce(a.name, m.name) AS personName
      WITH personKey, personName, r, min(c.displayRole) AS instrument
      WITH personKey, personName, collect({release: r, instrument: instrument}) AS apps
      WHERE size(apps) >= 2
      UNWIND apps AS app1
      UNWIND apps AS app2
      WITH personName, app1.release AS r1, app1.instrument AS instrument, app2.release AS r2
      WHERE r1.discogsId < r2.discogsId
      WITH r1, r2, collect(DISTINCT {name: personName, instrument: instrument}) AS sharedMusicians
      RETURN r1.discogsId AS releaseAId, r1.title AS releaseATitle,
             r2.discogsId AS releaseBId, r2.title AS releaseBTitle,
             sharedMusicians
      ORDER BY releaseAId, releaseBId
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
