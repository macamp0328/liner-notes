import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/** A Track node awaiting MusicBrainz identifier enrichment. */
export interface TrackForMusicBrainz {
  elementId: string;
  title: string;
  /** Ordinal track number within the release (from the HAS_TRACK relationship). */
  trackNumber: number;
  /** Track length in whole seconds; null when Discogs had no duration. */
  durationSeconds: number | null;
}

/** A Release with its full tracklist and credited artist names, ready for enrichment. */
export interface ReleaseForMusicBrainz {
  releaseDiscogsId: number;
  artistNames: string[];
  tracks: TrackForMusicBrainz[];
}

/** The MusicBrainz identifiers resolved for a single Track. Both ids are nullable. */
export interface TrackMusicBrainzResult {
  elementId: string;
  recordingMbid: string | null;
  isrc: string | null;
}

/**
 * Fetch every Release that has at least one Track without a musicBrainzFetched marker,
 * along with that release's full tracklist and credited artist names.
 *
 * The full tracklist (not just unfetched tracks) is returned because tracklist
 * alignment against MusicBrainz depends on ordinal position within the release.
 */
export async function getTracksForMusicBrainzEnrichment(
  driver: Driver,
): Promise<ReleaseForMusicBrainz[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)
       WHERE EXISTS { MATCH (r)-[:HAS_TRACK]->(tx:Track) WHERE tx.musicBrainzFetched IS NULL }
       MATCH (r)-[ht:HAS_TRACK]->(t:Track)
       WITH r, collect({
         elementId: elementId(t),
         title: t.title,
         trackNumber: ht.trackNumber,
         durationSeconds: t.durationSeconds
       }) AS tracks
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH r, tracks, a ORDER BY a.name
       RETURN r.discogsId AS releaseDiscogsId,
              [x IN collect(DISTINCT a.name) WHERE x IS NOT NULL | x] AS artistNames,
              tracks`,
    );

    return result.records.map((record) => {
      const rawTracks = record.get('tracks') as Array<{
        elementId: string;
        title: string;
        trackNumber: Neo4jInt;
        durationSeconds: Neo4jInt | null;
      }>;

      const tracks: TrackForMusicBrainz[] = rawTracks.map((t) => ({
        elementId: t.elementId,
        title: t.title,
        trackNumber: t.trackNumber.toNumber(),
        durationSeconds: t.durationSeconds === null ? null : t.durationSeconds.toNumber(),
      }));

      return {
        releaseDiscogsId: (record.get('releaseDiscogsId') as Neo4jInt).toNumber(),
        artistNames: record.get('artistNames') as string[],
        tracks,
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Write MusicBrainz identifiers onto Track nodes and mark each as fetched.
 *
 * Every track in `results` is marked with musicBrainzFetched = true regardless of
 * whether a match was found — the marker is the idempotency guard. recordingMbid
 * and isrc are set to their (possibly null) resolved values; a null value clears
 * the property, matching the nullable-by-design contract.
 */
export async function setTrackMusicBrainzIds(
  driver: Driver,
  results: TrackMusicBrainzResult[],
): Promise<void> {
  if (results.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $results AS res
       MATCH (t:Track) WHERE elementId(t) = res.elementId
       SET t.musicBrainzFetched = true,
           t.recordingMbid = res.recordingMbid,
           t.isrc = res.isrc`,
      { results },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all MusicBrainz enrichment from Track nodes: clears musicBrainzFetched,
 * recordingMbid, and isrc so the next enrichment run reprocesses every track.
 * Returns the number of tracks reset.
 */
export async function resetTrackMusicBrainzEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track) WHERE t.musicBrainzFetched IS NOT NULL
       REMOVE t.musicBrainzFetched, t.recordingMbid, t.isrc
       RETURN count(t) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
