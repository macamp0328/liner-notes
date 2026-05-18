import type { Driver } from 'neo4j-driver';
import type { AcousticBrainzFeatures } from '../ingestion/acousticbrainz-client.js';

type Neo4jInt = { toNumber(): number };

/** A Track node carrying a recording MBID and awaiting AcousticBrainz enrichment. */
export interface TrackForAcousticBrainz {
  elementId: string;
  recordingMbid: string;
}

/**
 * The AcousticBrainz features resolved for a single Track, flattened with its elementId
 * so it can be written in a single UNWIND. Every feature field is nullable.
 */
export type TrackAcousticBrainzResult = AcousticBrainzFeatures & { elementId: string };

/**
 * Fetch every Track that has a `recordingMbid` but no `acousticBrainzFetched` marker.
 *
 * AcousticBrainz is keyed purely by recording MBID, so — unlike the MusicBrainz
 * identifier enrichment — no release context or tracklist alignment is needed.
 */
export async function getTracksForAcousticBrainzEnrichment(
  driver: Driver,
): Promise<TrackForAcousticBrainz[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.recordingMbid IS NOT NULL AND t.acousticBrainzFetched IS NULL
       RETURN elementId(t) AS elementId, t.recordingMbid AS recordingMbid`,
    );

    return result.records.map((record) => ({
      elementId: record.get('elementId') as string,
      recordingMbid: record.get('recordingMbid') as string,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Write AcousticBrainz features onto Track nodes and mark each as fetched.
 *
 * Every track in `results` is marked `acousticBrainzFetched = true` regardless of whether
 * AcousticBrainz had data — the marker is the idempotency guard. Each feature is set to
 * its (possibly null) resolved value; a null clears the property, matching the
 * nullable-by-design contract.
 */
export async function setTrackAcousticBrainzFeatures(
  driver: Driver,
  results: TrackAcousticBrainzResult[],
): Promise<void> {
  if (results.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $results AS res
       MATCH (t:Track) WHERE elementId(t) = res.elementId
       SET t.acousticBrainzFetched = true,
           t.tempo = res.tempo,
           t.musicalKey = res.musicalKey,
           t.musicalScale = res.musicalScale,
           t.loudnessDb = res.loudnessDb,
           t.dynamicComplexity = res.dynamicComplexity,
           t.danceabilityEstimate = res.danceabilityEstimate,
           t.voiceInstrumental = res.voiceInstrumental`,
      { results },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all AcousticBrainz enrichment from Track nodes: clears `acousticBrainzFetched`
 * and every feature property so the next enrichment run reprocesses every track.
 * Returns the number of tracks reset.
 */
export async function resetTrackAcousticBrainzEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track) WHERE t.acousticBrainzFetched IS NOT NULL
       REMOVE t.acousticBrainzFetched, t.tempo, t.musicalKey, t.musicalScale,
              t.loudnessDb, t.dynamicComplexity, t.danceabilityEstimate, t.voiceInstrumental
       RETURN count(t) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
