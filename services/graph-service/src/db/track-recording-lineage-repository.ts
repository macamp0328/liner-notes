import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { MbRecordingDerivation } from '../ingestion/musicbrainz-client.js';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/** A distinct recording MBID and every candidate Track node that carries it. */
export interface RecordingForLineage {
  recordingMbid: string;
  trackElementIds: string[];
}

/**
 * Fetch every distinct `recordingMbid` whose Tracks still LACK an MB-sourced lineage edge and whose
 * last attempt has aged past the staleness window (issue #89), grouped so one MusicBrainz recording is
 * looked up once and fanned out to every Track carrying it (#434). Mirrors
 * `getTracksForRecordingPlacesEnrichment`: the `recordingMbid IS NOT NULL` gate is what makes this
 * stage depend on `track-musicbrainz` having run first, and the source-scoped `NOT EXISTS` guard keeps
 * an already-linked Track from being re-fetched every window — only a still-unlinked one is. Forced
 * re-fetch is the explicit `/track-recording-lineage/reset` route, per the *FetchedAt contract.
 */
export async function getTracksForRecordingLineageEnrichment(
  driver: Driver,
): Promise<RecordingForLineage[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.recordingMbid IS NOT NULL
         AND NOT EXISTS {
           (t)-[r:RELATED_RECORDING]->(:Recording)
           WHERE r.source = 'musicbrainz'
         }
         AND (t.recordingLineageFetchedAt IS NULL
              OR t.recordingLineageFetchedAt < datetime() - duration({ days: $stalenessDays }))
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
 * Write track-scoped `RELATED_RECORDING` edges to fallback `(:Recording)` nodes for a recording's
 * derivative lineage (#434), stamping `recordingLineageFetchedAt` on every candidate Track.
 *
 * The link target is a `(:Recording {mbid})` node MERGEd on the OTHER recording's MBID — the #335
 * fallback-Musician / #336 MBID-keyed-Work precedent — so an out-of-collection original or derivative
 * is still captured; an in-collection counterpart resolves at query time via the
 * `Recording.mbid → Track.recordingMbid` join. The edge's `type` is part of the MERGE key so two
 * distinct derivative types to the same target don't collapse, while `direction` is stored RAW (the MB
 * `forward`/`backward`, dropped when absent) — lineage is never normalised, so it can never be written
 * backwards; a route renders the human phrase. `recordingMbid` on the edge is the SOURCE recording's
 * MBID (provenance, matching the slice-2 `RECORDED_AT` pattern). The marker is stamped on EVERY
 * candidate Track, not only the ones an edge was created for, so a recording with no lineage is
 * throttled correctly.
 */
export async function mergeRecordingLineage(
  driver: Driver,
  recordingMbid: string,
  trackElementIds: string[],
  derivations: MbRecordingDerivation[],
): Promise<void> {
  if (derivations.length === 0 || trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $derivations AS d
       MERGE (rec:Recording { mbid: d.recordingMbid })
         ON CREATE SET rec.title = d.title
         ON MATCH SET rec.title =
           CASE WHEN coalesce(rec.title, '') = '' THEN d.title ELSE rec.title END
       WITH rec, d
       UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       MERGE (t)-[rel:RELATED_RECORDING { type: d.type }]->(rec)
         ON CREATE SET rel.source = 'musicbrainz', rel.direction = d.direction,
                       rel.recordingMbid = $recordingMbid
       SET t.recordingLineageFetchedAt = datetime()`,
      { recordingMbid, trackElementIds, derivations },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp `recordingLineageFetchedAt` on a recording's Tracks without writing any lineage — the
 * markAttempted path, reached when MusicBrainz returned no recording relations for the recording.
 * Throttles re-attempts to once per staleness window.
 */
export async function setRecordingLineageFetched(
  driver: Driver,
  trackElementIds: string[],
): Promise<void> {
  if (trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       SET t.recordingLineageFetchedAt = datetime()`,
      { trackElementIds },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all track-recording-lineage enrichment so a re-run reproduces it from scratch. Runs three
 * statements in one write transaction so a crash can't leave a half-reset graph:
 *   1. delete every MB-sourced `Track→Recording` `RELATED_RECORDING` edge (`source: 'musicbrainz'`);
 *   2. `DETACH DELETE` the now-orphaned fallback `Recording` nodes — these nodes are pure lineage
 *      link targets (only ever the head of a `RELATED_RECORDING` edge), so any left edgeless by step 1
 *      is run output, not a fact worth keeping; the `NOT (rec)--()` guard keeps it precise;
 *   3. clear the `recordingLineageFetchedAt` markers.
 * Returns the number of Tracks reset.
 */
export async function resetRecordingLineageEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    return await session.executeWrite(async (tx) => {
      await tx.run(
        `MATCH (:Track)-[r:RELATED_RECORDING]->(:Recording)
         WHERE r.source = 'musicbrainz'
         DELETE r`,
      );
      await tx.run(
        `MATCH (rec:Recording) WHERE NOT (rec)--()
         DETACH DELETE rec`,
      );
      const resetResult = await tx.run(
        `MATCH (t:Track) WHERE t.recordingLineageFetchedAt IS NOT NULL
         REMOVE t.recordingLineageFetchedAt
         RETURN count(t) AS reset`,
      );
      return (resetResult.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
    });
  } finally {
    await session.close();
  }
}
