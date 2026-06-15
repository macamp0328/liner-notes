import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/** A Track node awaiting MusicBrainz identifier enrichment. */
export interface TrackForMusicBrainz {
  elementId: string;
  title: string;
  /** Discogs position string (e.g. "A1", "B3", "2-5"); used to sort into album order. */
  position: string;
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
 * Fetch every Release that still has at least one Track without a resolved `recordingMbid`
 * whose last attempt has aged past the staleness window (issue #89), along with that
 * release's full tracklist and credited artist names. A track that already resolved an MBID
 * is never the reason a release is re-selected; a track MusicBrainz had no match for is
 * retried at most once per window.
 *
 * The full tracklist (not just unmatched tracks) is returned because tracklist
 * alignment against MusicBrainz depends on ordinal position within the release.
 */
export async function getTracksForMusicBrainzEnrichment(
  driver: Driver,
): Promise<ReleaseForMusicBrainz[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)
       WHERE EXISTS {
         MATCH (r)-[:HAS_TRACK]->(tx:Track)
         WHERE tx.recordingMbid IS NULL
           AND (tx.musicBrainzFetchedAt IS NULL
                OR tx.musicBrainzFetchedAt < datetime() - duration({ days: $stalenessDays }))
       }
       MATCH (r)-[ht:HAS_TRACK]->(t:Track)
       WITH r, collect({
         elementId: elementId(t),
         title: t.title,
         position: t.position,
         durationSeconds: t.durationSeconds
       }) AS tracks
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH r, tracks, a ORDER BY a.name
       RETURN r.discogsId AS releaseDiscogsId,
              [x IN collect(DISTINCT a.name) WHERE x IS NOT NULL | x] AS artistNames,
              tracks`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );

    return result.records.map((record) => {
      const rawTracks = record.get('tracks') as Array<{
        elementId: string;
        title: string;
        position: string;
        durationSeconds: Neo4jInt | null;
      }>;

      const tracks: TrackForMusicBrainz[] = rawTracks.map((t) => ({
        elementId: t.elementId,
        title: t.title,
        position: t.position,
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
 * Every track in `results` is stamped with musicBrainzFetchedAt = datetime() regardless of
 * whether a match was found — the timestamp throttles re-attempts to once per staleness
 * window. recordingMbid and isrc are set to their (possibly null) resolved values; a null
 * value clears the property, matching the nullable-by-design contract.
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
       SET t.musicBrainzFetchedAt = datetime(),
           t.recordingMbid = res.recordingMbid,
           t.isrc = res.isrc`,
      { results },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all MusicBrainz enrichment from Track nodes and cascade to every downstream
 * enrichment keyed off the identifiers it writes: AcousticBrainz (recordingMbid), Deezer
 * (isrc), and track-works (recordingMbid → Work, #336). Clearing them together ensures the
 * next enrichment run reprocesses from scratch without any stale markers, features, or — for
 * track-works — RECORDING_OF edges pointing at a recordingMbid that no longer exists. Runs in
 * one write transaction so the cascade can't be left half-applied.
 *
 * Returns the number of tracks reset.
 */
export async function resetTrackMusicBrainzEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    return await session.executeWrite(async (tx) => {
      const result = await tx.run(
        // acousticBrainzExhausted (#384) must be cleared here too: clearing recordingMbid drops
        // the AB features, so leaving the terminal marker set would permanently exclude the track
        // from AB enrichment even after MusicBrainz re-resolves a new recordingMbid.
        `MATCH (t:Track) WHERE t.musicBrainzFetchedAt IS NOT NULL
         REMOVE t.musicBrainzFetchedAt, t.recordingMbid, t.isrc, t.worksFetchedAt,
                t.acousticBrainzFetchedAt, t.acousticBrainzExhausted, t.tempo, t.musicalKey,
                t.musicalScale, t.loudnessDb, t.dynamicComplexity, t.danceabilityEstimate,
                t.voiceInstrumental, t.deezerFetchedAt, t.deezerBpm, t.deezerGain
         RETURN count(t) AS reset`,
      );
      // DETACH DELETE removes each Work together with its RECORDING_OF edges; recordingMbid is
      // being cleared graph-wide, so every Work/edge derived from it is now stale.
      await tx.run(`MATCH (w:Work) DETACH DELETE w`);
      return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
    });
  } finally {
    await session.close();
  }
}
