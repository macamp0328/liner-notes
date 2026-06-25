import neo4j, { Driver } from 'neo4j-driver';
import type { RoleCategory } from '../../ingestion/transforms.js';
import { normalizeCountry } from '../../ingestion/transforms.js';
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

/**
 * One band the queried Artist belonged to (#424), from the dated Wikidata P463 edge
 * `(:Artist)-[:MEMBER_OF {source:"wikidata"}]->(:Artist)` (#392). `since`/`until` are the begin/end
 * **year** of the tenure, `null` when Wikidata carried no P580/P582 qualifier. `wikidataQid` is the
 * QID the edge resolved on (always present — the edge can't exist without it). One entry per edge, so
 * once #427 represents multiple tenures as parallel edges the same band appears once per tenure.
 */
export interface MembershipBand {
  discogsId: number;
  name: string;
  wikidataQid: string;
  since: number | null;
  until: number | null;
}

/**
 * One in-collection bandmate of the queried Artist (#424): another Artist who is a Wikidata member of
 * one of the same bands. Tenure-less by design — it answers "who else was in these bands", not "when".
 */
export interface MembershipBandmate {
  discogsId: number;
  name: string;
  wikidataQid: string;
}

/**
 * The Wikidata band-membership neighbourhood of one Artist (#424): the `bands` they belonged to (with
 * tenure) and the `bandmates` they shared those bands with. Both restricted to in-collection artists
 * (the edges only ever link two Artist nodes that share the QID join), so the graph is sparse by
 * design. Both empty for an unknown name or one with no MEMBER_OF edges.
 */
export interface ArtistMembership {
  bands: MembershipBand[];
  bandmates: MembershipBandmate[];
}

export interface ConnectionNode {
  type: string;
  discogsId: number | null;
  name: string | null;
  title: string | null;
}

/**
 * A connection node annotated with its edge-specificity weight (#331). `degree` is the node's total
 * degree across the whole graph (`COUNT { (n)--() }`); `weight = 1/degree` so a hub node (a `Rock`
 * genre wired to ~150 releases) scores near zero while a niche node (a `Studio` on 2 releases) scores
 * ~0.5. `/connections` orders by `degree ASC` so the most specific connections survive the 200-cap.
 * Distinct from the bare {@link ConnectionNode} (reused by the #343 path types, which must NOT carry
 * these fields).
 */
export type WeightedConnectionNode = ConnectionNode & {
  degree: number;
  weight: number;
};

export interface ConnectionsResult {
  seed: ExploreRelease;
  nodes: WeightedConnectionNode[];
}

/**
 * One shared neighbour ("bridge") linking the seed release to a related release (#331): the node
 * label `type` (Musician / Studio / Artist / …), its display `name`, and the edge-specificity
 * `weight = 1/degree(bridge)`. A shared niche studio outweighs a shared prolific session player.
 */
export interface ConnectionBridge {
  type: string;
  name: string | null;
  weight: number;
}

/**
 * A release ranked as related to a seed (#331), with the bridges that earned its rank. `score` is the
 * sum of every shared bridge's `weight` (`Σ 1/degree`); `bridges` is that breakdown, strongest-first
 * and capped for payload size (the full set still feeds `score`). Bridges traverse only the #343
 * `PATH_RELATIONSHIPS` allowlist, so genre/country/label/track hubs and the same-headline-artist
 * `RELEASED_BY` edge are excluded by construction — every bridge is a shared person or studio.
 */
export interface RelatedRelease extends ExploreRelease {
  score: number;
  bridges: ConnectionBridge[];
}

/**
 * One endpoint of a six-degrees path query (#343): a Release (numeric Discogs id) or a person
 * (a `Musician`/`Artist` matched by name). The route parses each raw `from`/`to` query value into
 * one of these — numeric ⇒ release, anything else ⇒ person — so the two ends can be mixed.
 */
export type PathEndpoint =
  | { kind: 'release'; discogsId: number }
  | { kind: 'person'; name: string };

/**
 * One hop along a shortest path (#343): the relationship traversed to reach `node`, plus *why* it
 * connects. `forward` is true when the edge was walked along its stored direction — traversal is
 * undirected, so arriving at a `Musician` from the `Release` they are `CREDITED_ON` is
 * `forward: false`. `role` carries the credit role (`CREDITED_ON`) or the studio relation
 * (`RECORDED_AT` — `recorded at`/`mixed at`); `instrument` is set only for instrument credits;
 * `source` is edge provenance where present (e.g. `musicbrainz`/`wikidata`). All three are null for
 * `SAME_PERSON_AS`/`MEMBER_OF` hops, which the `relationship` type alone explains.
 */
export interface PathStep {
  relationship: string;
  forward: boolean;
  role: string | null;
  instrument: string | null;
  source: string | null;
  node: ConnectionNode;
}

/**
 * Result of a shortest human/credit path search between two endpoints (#343). `from`/`to` are the
 * resolved endpoint nodes, or null when an identifier matched no node (the route turns a null end
 * into a 404). `found` is whether a path exists within `maxDepth`; `length` is the hop count — 0
 * when both ends resolve to the same node, null when not found. `steps` reconstructs the path: the
 * full node sequence is `[from, ...steps.map((s) => s.node)]`, and `steps[i].relationship` is the
 * edge between node i and node i+1.
 */
export interface PathResult {
  from: ConnectionNode | null;
  to: ConnectionNode | null;
  found: boolean;
  length: number | null;
  maxDepth: number;
  steps: PathStep[];
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
 *     additionally include their group's records — an INFERRED involvement (the group's catalog, not
 *     necessarily records the person personally played on), now **temporally guarded** (#424): the
 *     member→group expansion carries the Wikidata P463 tenure window (`since`/`until`, #392) bridged
 *     from the Discogs Musician membership to the Artist layer via SAME_PERSON_AS, and a group record
 *     is dropped only on positive evidence it falls OUTSIDE a known tenure — both the release year and
 *     a tenure bound known and the year out of range. Unknown year or absent/unbounded tenure keeps
 *     the record (include-when-unknown). The guard narrows ONLY this inferred expansion: a record the
 *     member personally played on arrives via the self/sibling branches (no window) and is never
 *     dropped. The reverse (group→members) is deliberately NOT expanded: it would attribute every
 *     member's unrelated solo credit to the group, making the group look involved in records it never
 *     touched (PR #330 review). A group query therefore returns only the group's own credits; the
 *     MEMBER_OF edges still exist and are surfaced via /stats.
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
        // self + alias siblings: no tenure window — always included (a person's own credits).
        WITH s RETURN s AS person, null AS since, null AS until
        UNION WITH s MATCH (s)-[:SAME_PERSON_AS]->(:Artist)<-[:SAME_PERSON_AS]-(sib:Musician)
          RETURN sib AS person, null AS since, null AS until
        // member→group: carry the Wikidata P463 tenure window (#424), bridged from the Discogs
        // Musician MEMBER_OF to the Artist-layer dated edge via SAME_PERSON_AS. The Discogs edge is
        // labelled :Musician on both ends and the Wikidata edge :Artist+{source:'wikidata'} (the #392
        // guardrail — keep the two MEMBER_OF graphs from conflating). The bridge is OPTIONAL, so a
        // group with no Wikidata tenure resolves to a null window → unbounded (include-when-unknown).
        UNION WITH s
          MATCH (s)-[:MEMBER_OF]->(grp:Musician)
          OPTIONAL MATCH (s)-[:SAME_PERSON_AS]->(:Artist)-[mem:MEMBER_OF {source:'wikidata'}]->(:Artist)<-[:SAME_PERSON_AS]-(grp)
          RETURN grp AS person, mem.since AS since, mem.until AS until
      }
      WITH DISTINCT person, since, until
      MATCH (person)-[c:CREDITED_ON]->(target)
      WHERE target:Release OR target:Track
      OPTIONAL MATCH (rTrack:Release)-[:HAS_TRACK]->(target)
      WITH (CASE WHEN target:Release THEN target ELSE rTrack END) AS r, c, since, until
      WHERE r IS NOT NULL
        // Temporal guard (#424): drop a member's INFERRED group record only on positive evidence it
        // sits outside a known tenure. Unbounded window, unknown release year, or in-range → keep.
        // include-if-any-window: a release kept by one (person,window) row survives the dedup below.
        AND (
          (since IS NULL AND until IS NULL)
          OR coalesce(r.originalYear, r.pressingYear) IS NULL
          OR (
            (since IS NULL OR coalesce(r.originalYear, r.pressingYear) >= since)
            AND (until IS NULL OR coalesce(r.originalYear, r.pressingYear) <= until)
          )
        )
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
// getArtistMembership
// ---------------------------------------------------------------------------

/**
 * The Wikidata P463 band-membership neighbourhood of one Artist (#424), resolved case-insensitively by
 * name. `bands` are the groups this artist belonged to (outgoing `MEMBER_OF {source:'wikidata'}`, with
 * the `since`/`until` tenure); `bandmates` are the other in-collection members of those bands. Only
 * in-collection artists appear — the dated edges only ever link two Artist nodes that share the QID
 * join. Returns empty arrays for an unknown name or one with no membership edges.
 *
 * Like {@link getArtistInfluences}, `Artist.name` is not unique, so the two `collect`s run AFTER both
 * OPTIONAL MATCHes with no grouping key — unioning every matched root's neighbours into one row. A
 * per-node `WITH a, collect(...)` would split by node and silently return one node's slice. `collect`
 * drops the no-match `null` row (the `CASE WHEN … IS NULL THEN null`), so an artist with no bands
 * yields `[]`, not `[{discogsId:null,…}]`. The membership edge is matched with its `:Artist` labels
 * and `{source:'wikidata'}` explicit (the #392 guardrail — an unlabeled `[:MEMBER_OF]` would conflate
 * the Discogs Musician→Musician graph). One row per edge, so #427's future parallel tenure edges add
 * extra `bands` entries for the same band with no change here.
 */
export async function getArtistMembership(driver: Driver, name: string): Promise<ArtistMembership> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:Artist) WHERE toLower(a.name) = toLower($name)
      OPTIONAL MATCH (a)-[m:MEMBER_OF {source:'wikidata'}]->(band:Artist)
      OPTIONAL MATCH (band)<-[:MEMBER_OF {source:'wikidata'}]-(mate:Artist) WHERE mate <> a
      WITH
        collect(DISTINCT CASE WHEN band IS NULL THEN null ELSE
          { discogsId: band.discogsId, name: band.name, wikidataQid: band.wikidataQid,
            since: m.since, until: m.until } END) AS bands,
        collect(DISTINCT CASE WHEN mate IS NULL THEN null ELSE
          { discogsId: mate.discogsId, name: mate.name, wikidataQid: mate.wikidataQid } END) AS bandmates
      RETURN bands, bandmates
      `,
      { name },
    );
    const record = result.records[0];
    const mapBands = (raw: unknown): MembershipBand[] =>
      ((raw as Array<Record<string, unknown>> | null) ?? []).map((x) => ({
        discogsId: toInt(x['discogsId']) ?? 0,
        name: toStr(x['name']) ?? '',
        wikidataQid: toStr(x['wikidataQid']) ?? '',
        since: toInt(x['since']),
        until: toInt(x['until']),
      }));
    const mapBandmates = (raw: unknown): MembershipBandmate[] =>
      ((raw as Array<Record<string, unknown>> | null) ?? []).map((x) => ({
        discogsId: toInt(x['discogsId']) ?? 0,
        name: toStr(x['name']) ?? '',
        wikidataQid: toStr(x['wikidataQid']) ?? '',
      }));
    return {
      bands: record ? mapBands(record.get('bands')) : [],
      bandmates: record ? mapBandmates(record.get('bandmates')) : [],
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
  // Resolve the request to its ISO `:Country` code(s) so legacy/alias inputs still match the
  // normalized nodes (#441): `?name=UK` and `?name=Germany` now find `GB`/`DE`. A pure-region input
  // (`Europe`) yields no country codes and returns nothing — regions are not country queries (a
  // dedicated /explore/region route is a follow-up). The raw input is included as a fallback so
  // unmapped defunct-state names (e.g. `Yugoslavia`) keep working.
  const { countries } = normalizeCountry(name);
  // Lower-case before de-duping so case-variant aliases collapse to one term; the raw `name` is kept
  // as a fallback so unmapped/defunct-state names (e.g. `Yugoslavia`) still match their name-keyed node.
  const codes = [...new Set([...countries, name].map((c) => c.toLowerCase()))];
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:FROM_COUNTRY]->(c:Country)
      WHERE toLower(c.name) IN $codes
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { codes },
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
      WITH start, sa, connected, COUNT { (connected)-[]-() } AS degree
      ORDER BY degree ASC
      LIMIT 200
      WITH start, sa, collect({
             type: head(labels(connected)),
             discogsId: connected.discogsId,
             name: connected.name,
             title: connected.title,
             degree: degree,
             weight: 1.0 / degree
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
      degree: unknown;
      weight: unknown;
    }>;
    const nodes: WeightedConnectionNode[] = rawNodes
      .filter((n) => n.type !== null)
      .map((n) => ({
        type: toStr(n.type) ?? '',
        discogsId: toInt(n.discogsId),
        name: toStr(n.name),
        title: toStr(n.title),
        degree: toInt(n.degree) ?? 0,
        weight: toFloat(n.weight) ?? 0,
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
      MATCH (m:Master)-[:RELEASED_IN|RELEASED_IN_REGION]->(p)
      WHERE p:Country OR p:Region
      WITH m.discogsId AS masterDiscogsId, m.title AS albumTitle,
           collect(DISTINCT p.name) AS countries
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

// ---------------------------------------------------------------------------
// getPath — the "six degrees" finder (#343)
//
// Shortest path between two endpoints over an EXPLICIT relationship allowlist —
// CREDITED_ON | RECORDED_AT | SAME_PERSON_AS | MEMBER_OF — so the chain runs
// through the session players, producers, engineers, and studios that connect
// two records, NOT the genre/country/label hubs that connect everything to
// everything. Hub node types are excluded BY CONSTRUCTION: a Genre/Style/
// Country/Label is reachable only via an edge OUTSIDE the allowlist (IN_GENRE /
// FROM_COUNTRY / ON_LABEL / RELEASED_BY / HAS_TRACK), so the walk simply never
// arrives at one — and crucially we add NO node-label `WHERE` over nodes(p),
// which would force Neo4j's slow exhaustive-search fallback instead of the fast
// bidirectional-BFS shortestPath planner.
//
// MEMBER_OF is traversed UNDIRECTED here, unlike getReleasesByMusician (which
// expands it one way only to avoid over-attributing a group's whole catalog to a
// member). A path reports an association CHAIN ("both are members of band G"),
// not responsibility, so symmetric traversal is correct. RELEASED_BY (the primary
// artist) is intentionally omitted from the allowlist — the point is the shared
// session-player/studio link, not "same headline artist".
//
// maxDepth is a validated integer interpolated into the var-length bound (Cypher
// cannot parameterize a var-length upper bound), coerced to [1, 6] at runtime as
// defense-in-depth — same shape as getConnections' depth.
// ---------------------------------------------------------------------------

const PATH_RELATIONSHIPS = 'CREDITED_ON|RECORDED_AT|SAME_PERSON_AS|MEMBER_OF';
const PATH_MAX_DEPTH_CEILING = 6;
const PATH_QUERY_TIMEOUT_MS = 15_000;

interface RawPathNode {
  type: unknown;
  discogsId: unknown;
  name: unknown;
  title: unknown;
}

interface RawPathRel {
  type: unknown;
  forward: unknown;
  role: unknown;
  instrument: unknown;
  source: unknown;
}

function mapPathNode(n: RawPathNode): ConnectionNode {
  return {
    type: toStr(n.type) ?? '',
    discogsId: toInt(n.discogsId),
    name: toStr(n.name),
    title: toStr(n.title),
  };
}

export async function getPath(
  driver: Driver,
  from: PathEndpoint,
  to: PathEndpoint,
  maxDepth: number,
): Promise<PathResult> {
  const rounded = Math.round(maxDepth);
  const safeMaxDepth = Number.isFinite(rounded)
    ? Math.min(PATH_MAX_DEPTH_CEILING, Math.max(1, rounded))
    : PATH_MAX_DEPTH_CEILING;
  const session = driver.session();
  try {
    // Resolve each endpoint by label-anchored OPTIONAL MATCH (never an unbound `(n)` pattern, which
    // is an AllNodesScan) + coalesce: numeric ⇒ Release by id, string ⇒ Musician/Artist by name
    // (Musician preferred — SAME_PERSON_AS bridges to the Artist anyway). Persons order by `name`,
    // not the nullable `discogsId` (id-0 / MBID-only people have none). Both ends resolve to a single
    // representative node, then shortestPath runs over the allowlist. A self-pair (from = to) yields
    // no path under `*1..`, so it is reported via `sameNode` and synthesized as length 0.
    const query = `
      OPTIONAL MATCH (frR:Release)  WHERE frR.discogsId = $fromId
      OPTIONAL MATCH (frM:Musician) WHERE $fromName IS NOT NULL AND toLower(frM.name) = toLower($fromName)
      WITH frR, frM ORDER BY frM.name LIMIT 1
      OPTIONAL MATCH (frA:Artist)   WHERE $fromName IS NOT NULL AND toLower(frA.name) = toLower($fromName)
      WITH frR, frM, frA ORDER BY frA.name LIMIT 1
      WITH coalesce(frR, frM, frA) AS from
      OPTIONAL MATCH (toR:Release)  WHERE toR.discogsId = $toId
      WITH from, toR
      OPTIONAL MATCH (toM:Musician) WHERE $toName IS NOT NULL AND toLower(toM.name) = toLower($toName)
      WITH from, toR, toM ORDER BY toM.name LIMIT 1
      OPTIONAL MATCH (toA:Artist)   WHERE $toName IS NOT NULL AND toLower(toA.name) = toLower($toName)
      WITH from, toR, toM, toA ORDER BY toA.name LIMIT 1
      WITH from, coalesce(toR, toM, toA) AS to
      OPTIONAL MATCH p = shortestPath((from)-[:${PATH_RELATIONSHIPS}*1..${safeMaxDepth}]-(to))
      RETURN
        CASE WHEN from IS NULL THEN null
             ELSE {type: head(labels(from)), discogsId: from.discogsId, name: from.name, title: from.title} END AS fromNode,
        CASE WHEN to IS NULL THEN null
             ELSE {type: head(labels(to)), discogsId: to.discogsId, name: to.name, title: to.title} END AS toNode,
        (from IS NOT NULL AND to IS NOT NULL AND from = to) AS sameNode,
        p IS NOT NULL AS found,
        CASE WHEN p IS NULL THEN null ELSE length(p) END AS len,
        CASE WHEN p IS NULL THEN []
             ELSE [n IN nodes(p) | {type: head(labels(n)), discogsId: n.discogsId, name: n.name, title: n.title}] END AS pathNodes,
        CASE WHEN p IS NULL THEN []
             ELSE [i IN range(0, length(p) - 1) |
               {type: type(relationships(p)[i]),
                forward: startNode(relationships(p)[i]) = nodes(p)[i],
                role: coalesce(relationships(p)[i].displayRole, relationships(p)[i].role, relationships(p)[i].relation),
                instrument: relationships(p)[i].instrument,
                source: relationships(p)[i].source}] END AS pathRels
    `;
    const params = {
      fromId: from.kind === 'release' ? neo4j.int(from.discogsId) : null,
      fromName: from.kind === 'person' ? from.name : null,
      toId: to.kind === 'release' ? neo4j.int(to.discogsId) : null,
      toName: to.kind === 'person' ? to.name : null,
    };
    const result = await session.run(query, params, { timeout: PATH_QUERY_TIMEOUT_MS });
    const rec = result.records[0];
    if (!rec) {
      return {
        from: null,
        to: null,
        found: false,
        length: null,
        maxDepth: safeMaxDepth,
        steps: [],
      };
    }

    const fromRaw = rec.get('fromNode') as RawPathNode | null;
    const toRaw = rec.get('toNode') as RawPathNode | null;
    const fromNode = fromRaw ? mapPathNode(fromRaw) : null;
    const toNode = toRaw ? mapPathNode(toRaw) : null;

    // from === to: shortestPath with `*1..` finds no self-path, so synthesize a length-0 result.
    if (rec.get('sameNode') === true) {
      return {
        from: fromNode,
        to: toNode,
        found: true,
        length: 0,
        maxDepth: safeMaxDepth,
        steps: [],
      };
    }

    if (rec.get('found') !== true) {
      return {
        from: fromNode,
        to: toNode,
        found: false,
        length: null,
        maxDepth: safeMaxDepth,
        steps: [],
      };
    }

    const rawNodes = rec.get('pathNodes') as RawPathNode[];
    const rawRels = rec.get('pathRels') as RawPathRel[];
    // pathNodes has one more entry than pathRels; step i traverses rawRels[i] to reach pathNodes[i+1].
    const steps: PathStep[] = rawRels.map((r, i) => {
      const next = rawNodes[i + 1];
      return {
        relationship: toStr(r.type) ?? '',
        forward: r.forward === true,
        role: toStr(r.role),
        instrument: toStr(r.instrument),
        source: toStr(r.source),
        node: next ? mapPathNode(next) : { type: '', discogsId: null, name: null, title: null },
      };
    });
    return {
      from: fromNode,
      to: toNode,
      found: true,
      length: toInt(rec.get('len')),
      maxDepth: safeMaxDepth,
      steps,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getRelatedReleases — edge-specificity-weighted relatedness ranking (#331)
//
// For a seed release, find OTHER releases sharing a neighbour ("bridge") node and rank them by
// `Σ 1/degree(bridge)` over the shared bridges. Two ideas combine, both from the issue:
//
//   1. Hub suppression by the SAME relationship allowlist `getPath` (#343) uses
//      (PATH_RELATIONSHIPS). Genre/Style/Country/Label/Track and the same-headline-artist
//      RELEASED_BY edge are excluded BY CONSTRUCTION — they are only reachable via edges outside
//      the allowlist — so every bridge is a shared session player, producer, engineer, studio,
//      group, or resolved-same-person. This is the primary "shares a producer, not is-also-rock"
//      filter; we add NO node-label WHERE (which would force a slow scan).
//   2. Inverse-degree weighting (1/degree) as the REFINEMENT over that already-clean set: a niche
//      shared studio (degree ~2 → 0.5) outranks a prolific shared session player (degree ~30 →
//      0.03). Degree is cheap plain Cypher (COUNT {}) — no GDS (unavailable on Aura Free), no
//      precomputed property, no refresh job.
//
// A per-bridge degree cap (RELATED_MAX_BRIDGE_DEGREE) drops any residual hyper-connected bridge
// belt-and-suspenders, and the query runs under the shared PATH_QUERY_TIMEOUT_MS budget. The seed
// is existence-checked first so an absent id is a 404 (null) while an isolated release is an empty
// array. The bridge breakdown carries the node LABEL (Musician/Studio/…), not the CREDITED_ON
// roleCategory — the label already answers "shared studio vs shared person"; a precise "shared
// producer" filter would need to choose which of the two bridge edges' role applies (deferred).
// ---------------------------------------------------------------------------

const RELATED_MAX_BRIDGE_DEGREE = 50;
const RELATED_BRIDGE_DISPLAY = 12;

interface RawBridge {
  type: unknown;
  name: unknown;
  weight: unknown;
}

export async function getRelatedReleases(
  driver: Driver,
  discogsId: number,
  limit: number,
): Promise<RelatedRelease[] | null> {
  const rounded = Math.round(limit);
  const safeLimit = Number.isFinite(rounded) ? Math.min(100, Math.max(1, rounded)) : 25;
  const session = driver.session();
  try {
    const exists = await session.run(
      `MATCH (r:Release {discogsId: $discogsId}) RETURN r.discogsId AS id LIMIT 1`,
      { discogsId: neo4j.int(discogsId) },
    );
    if (exists.records.length === 0) return null;

    const query = `
      MATCH (start:Release {discogsId: $discogsId})
        -[:${PATH_RELATIONSHIPS}]-(bridge)
        -[:${PATH_RELATIONSHIPS}]-(other:Release)
      WHERE other.discogsId <> start.discogsId
      WITH DISTINCT other, bridge
      WITH other, bridge, COUNT { (bridge)-[]-() } AS deg
      WHERE deg > 0 AND deg <= $maxBridgeDegree
      WITH other,
           sum(1.0 / deg) AS score,
           collect({
             type: head(labels(bridge)),
             name: coalesce(bridge.name, bridge.title),
             weight: 1.0 / deg
           }) AS bridges
      OPTIONAL MATCH (other)-[:RELEASED_BY]->(sa:Artist)
      RETURN other.discogsId AS discogsId, other.title AS title, sa.name AS artist,
             coalesce(other.originalYear, other.pressingYear) AS pressingYear,
             other.format AS format, other.thumbUrl AS thumbUrl,
             score, bridges
      ORDER BY score DESC, other.discogsId ASC
      LIMIT $limit
    `;
    const result = await session.run(
      query,
      {
        discogsId: neo4j.int(discogsId),
        maxBridgeDegree: neo4j.int(RELATED_MAX_BRIDGE_DEGREE),
        limit: neo4j.int(safeLimit),
      },
      { timeout: PATH_QUERY_TIMEOUT_MS },
    );
    return result.records.map((rec) => {
      const rawBridges = (rec.get('bridges') as RawBridge[])
        .map((b) => ({
          type: toStr(b.type) ?? '',
          name: toStr(b.name),
          weight: toFloat(b.weight) ?? 0,
        }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, RELATED_BRIDGE_DISPLAY);
      return {
        ...mapExploreRelease(rec),
        score: toFloat(rec.get('score')) ?? 0,
        bridges: rawBridges,
      };
    });
  } finally {
    await session.close();
  }
}
