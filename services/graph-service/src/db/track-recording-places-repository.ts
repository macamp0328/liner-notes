import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { MbRecordingPlace } from '../ingestion/musicbrainz-client.js';
import { getStalenessDays } from '../enrichment/staleness.js';
import { mergeStudioClause } from './canonical-merges.js';

type Neo4jInt = { toNumber(): number };

/** A distinct recording MBID and every candidate Track node that carries it. */
export interface RecordingForPlaces {
  recordingMbid: string;
  trackElementIds: string[];
}

/**
 * Fetch every distinct `recordingMbid` whose Tracks still LACK an MB-sourced studio edge and whose
 * last attempt has aged past the staleness window (issue #89), grouped so one MusicBrainz recording is
 * looked up once and fanned out to every Track carrying it. Mirrors
 * `getTracksForRecordingArtistsEnrichment`: the `recordingMbid IS NOT NULL` gate is what makes this
 * stage depend on `track-musicbrainz` having run first, and the source-scoped `NOT EXISTS` guard keeps
 * an already-attributed Track from being re-fetched every window — only a still-unattributed one is.
 * The `source: 'musicbrainz'` filter is defensive: a Discogs `RECORDED_AT` edge is `Release→Studio`,
 * never `Track→Studio`, but scoping the guard future-proofs it against any later Track-studio source.
 * Forced re-fetch is the explicit `/track-recording-places/reset` route, per the *FetchedAt contract.
 */
export async function getTracksForRecordingPlacesEnrichment(
  driver: Driver,
): Promise<RecordingForPlaces[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.recordingMbid IS NOT NULL
         AND NOT EXISTS {
           (t)-[r:RECORDED_AT]->(:Studio)
           WHERE r.source = 'musicbrainz'
         }
         AND (t.recordingPlacesFetchedAt IS NULL
              OR t.recordingPlacesFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN t.recordingMbid AS recordingMbid, collect(elementId(t)) AS trackElementIds`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((record) => ({
      recordingMbid: record.get('recordingMbid') as string,
      trackElementIds: record.get('trackElementIds') as string[],
    }));
  } finally {
    await session.close();
  }
}

/**
 * Write track-scoped `RECORDED_AT` edges for a recording's studios (#339, slice 2), stamping
 * `recordingPlacesFetchedAt` on every candidate Track.
 *
 * The Studio is MERGEd by `name` — the same name-key as the Discogs `(:Release)-[:RECORDED_AT]->`
 * path — so a track's MusicBrainz studio lines up with the album's Discogs studio of the same name
 * (Discogs carries no Place MBID, so name is the only shared join key). The Place's coordinates / area
 * / MBID enrich the node via `coalesce` so they only ever fill a gap: a later fetch returning null
 * coordinates never clobbers good ones, and an existing Discogs Studio gains location data without
 * losing anything. The edge carries `source: 'musicbrainz'`, the `recordingMbid`, and the MB relation
 * type (`recorded at` / `mixed at`) for provenance. The marker is stamped on EVERY candidate Track,
 * not only the ones an edge was created for, so a recording with no studios is throttled correctly.
 */
export async function mergeRecordingPlaces(
  driver: Driver,
  recordingMbid: string,
  trackElementIds: string[],
  places: MbRecordingPlace[],
): Promise<void> {
  if (places.length === 0 || trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $places AS p
       ${mergeStudioClause('p.name')}
         SET s.latitude = coalesce(p.latitude, s.latitude),
             s.longitude = coalesce(p.longitude, s.longitude),
             s.area = coalesce(p.area, s.area),
             s.musicbrainzPlaceId = coalesce(p.placeMbid, s.musicbrainzPlaceId)
       WITH s, p
       UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       MERGE (t)-[ra:RECORDED_AT]->(s)
         ON CREATE SET ra.source = 'musicbrainz', ra.recordingMbid = $recordingMbid,
                       ra.relation = p.relation
       SET t.recordingPlacesFetchedAt = datetime()`,
      { recordingMbid, trackElementIds, places },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp `recordingPlacesFetchedAt` on a recording's Tracks without writing any studio — the
 * markAttempted path, reached when MusicBrainz returned no place relations for the recording.
 * Throttles re-attempts to once per staleness window.
 */
export async function setRecordingPlacesFetched(
  driver: Driver,
  trackElementIds: string[],
): Promise<void> {
  if (trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       SET t.recordingPlacesFetchedAt = datetime()`,
      { trackElementIds },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all track-recording-places enrichment so a re-run reproduces it from scratch. Runs two
 * statements in one write transaction so a crash can't leave a half-reset graph:
 *   1. delete every MB-sourced `Track→Studio` `RECORDED_AT` edge (`source: 'musicbrainz'`);
 *   2. clear the `recordingPlacesFetchedAt` markers.
 * Studio nodes — and their coordinates — are deliberately LEFT INTACT: they are facts about the
 * physical studio (shared, name-keyed with the Discogs path) and feed the recording-location map
 * (#342), not run output. Returns the number of Tracks reset.
 */
export async function resetRecordingPlacesEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    return await session.executeWrite(async (tx) => {
      await tx.run(
        `MATCH (:Track)-[r:RECORDED_AT]->(:Studio)
         WHERE r.source = 'musicbrainz'
         DELETE r`,
      );
      const resetResult = await tx.run(
        `MATCH (t:Track) WHERE t.recordingPlacesFetchedAt IS NOT NULL
         REMOVE t.recordingPlacesFetchedAt
         RETURN count(t) AS reset`,
      );
      return (resetResult.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
    });
  } finally {
    await session.close();
  }
}
