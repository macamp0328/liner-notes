import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { MbWorkWriter } from '../ingestion/musicbrainz-client.js';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/** A distinct recording MBID and every candidate Track node that carries it. */
export interface RecordingForWorks {
  recordingMbid: string;
  trackElementIds: string[];
}

/** A MusicBrainz Work to MERGE, with its writers split into the aligned arrays stored on the node. */
export interface WorkToMerge {
  mbid: string;
  title: string;
  type: string | null;
  writers: MbWorkWriter[];
}

/**
 * Fetch every distinct `recordingMbid` that still has at least one Track without a resolved Work
 * (no `worksFetchedAt`, or aged past the staleness window — issue #89), grouped so one MusicBrainz
 * recording is looked up once and fanned out to every Track carrying it. The `recordingMbid IS NOT
 * NULL` gate is what makes this stage depend on `track-musicbrainz` having run first (#336).
 */
export async function getTracksForWorksEnrichment(driver: Driver): Promise<RecordingForWorks[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.recordingMbid IS NOT NULL
         AND (t.worksFetchedAt IS NULL
              OR t.worksFetchedAt < datetime() - duration({ days: $stalenessDays }))
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
 * MERGE the resolved Work(s) for a recording and link every candidate Track to them via
 * RECORDING_OF (provenance `source: 'musicbrainz'`), stamping `worksFetchedAt` on each Track.
 *
 * Writers (composer/lyricist/writer) are stored as index-aligned arrays on the Work — raw,
 * provenance-tagged MusicBrainz capture retaining each writer's MB artist MBID, so a future pass
 * can reconcile them to our Discogs-keyed Musician nodes and promote them to `WROTE` edges
 * deterministically. They are set only when present, so a Work with no captured writers keeps a
 * null (not an ambiguous empty list).
 *
 * A Track may be a recording of more than one Work (medleys), so the double UNWIND links every
 * candidate Track to every Work.
 */
export async function mergeTrackWorks(
  driver: Driver,
  trackElementIds: string[],
  works: WorkToMerge[],
): Promise<void> {
  if (works.length === 0 || trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $works AS work
       MERGE (w:Work {mbid: work.mbid})
       SET w.title = work.title, w.type = work.type
       FOREACH (_ IN CASE WHEN size(work.writerMbids) > 0 THEN [1] ELSE [] END |
         SET w.writers = work.writers,
             w.writerMbids = work.writerMbids,
             w.writerRoles = work.writerRoles)
       WITH w
       UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       MERGE (t)-[r:RECORDING_OF]->(w)
       SET r.source = 'musicbrainz', t.worksFetchedAt = datetime()`,
      {
        trackElementIds,
        works: works.map((w) => ({
          mbid: w.mbid,
          title: w.title,
          type: w.type,
          writers: w.writers.map((x) => x.name),
          writerMbids: w.writers.map((x) => x.mbid),
          writerRoles: w.writers.map((x) => x.role),
        })),
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp `worksFetchedAt` on a recording's Tracks without writing any Work — the markAttempted path,
 * reached when MusicBrainz returned no Work for the recording. Throttles re-attempts to once per
 * staleness window.
 */
export async function setTrackWorksFetched(
  driver: Driver,
  trackElementIds: string[],
): Promise<void> {
  if (trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       SET t.worksFetchedAt = datetime()`,
      { trackElementIds },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all track-works enrichment: clear `worksFetchedAt` markers, delete every RECORDING_OF
 * relationship, and delete the now-orphaned Work nodes. Returns the number of Tracks reset.
 */
export async function resetTrackWorksEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const resetResult = await session.run(
      `MATCH (t:Track) WHERE t.worksFetchedAt IS NOT NULL
       REMOVE t.worksFetchedAt
       RETURN count(t) AS reset`,
    );
    const reset = (resetResult.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;

    await session.run(`MATCH ()-[r:RECORDING_OF]->() DELETE r`);
    await session.run(`MATCH (w:Work) DETACH DELETE w`);

    return reset;
  } finally {
    await session.close();
  }
}
