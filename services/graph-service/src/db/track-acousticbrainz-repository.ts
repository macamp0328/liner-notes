import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { AcousticBrainzFeatures } from '../ingestion/acousticbrainz-client.js';
import { getStalenessDays } from '../enrichment/staleness.js';

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
 * Fetch every Track that has a `recordingMbid` but still no AcousticBrainz features, plus
 * any such track whose last attempt has aged past the staleness window (issue #89).
 * "No features" means ALL seven feature properties are null — the low-level and high-level
 * documents are fetched independently and merged, so a recording can carry e.g. a key/scale
 * but no tempo (and `bpm: 0` is itself coerced to null), making any single field an unsafe
 * sentinel. The `coalesce(...) IS NULL` mirrors the enrichment's own "≥1 feature = processed"
 * rule, so a track that already has any feature is never re-fetched; one AcousticBrainz had
 * nothing for is retried at most once per window.
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
       WHERE t.recordingMbid IS NOT NULL
         AND coalesce(t.tempo, t.musicalKey, t.musicalScale, t.loudnessDb,
                      t.dynamicComplexity, t.danceabilityEstimate, t.voiceInstrumental) IS NULL
         AND (t.acousticBrainzFetchedAt IS NULL
              OR t.acousticBrainzFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN elementId(t) AS elementId, t.recordingMbid AS recordingMbid`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
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
 * Every track in `results` is stamped with `acousticBrainzFetchedAt = datetime()` regardless
 * of whether AcousticBrainz had data — the timestamp throttles re-attempts to once per
 * staleness window. Each feature is set to its (possibly null) resolved value; a null clears
 * the property, matching the nullable-by-design contract.
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
       SET t.acousticBrainzFetchedAt = datetime(),
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
 * Remove all AcousticBrainz enrichment from Track nodes: clears `acousticBrainzFetchedAt`
 * and every feature property so the next enrichment run reprocesses every track.
 * Returns the number of tracks reset.
 */
export async function resetTrackAcousticBrainzEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track) WHERE t.acousticBrainzFetchedAt IS NOT NULL
       REMOVE t.acousticBrainzFetchedAt, t.tempo, t.musicalKey, t.musicalScale,
              t.loudnessDb, t.dynamicComplexity, t.danceabilityEstimate, t.voiceInstrumental
       RETURN count(t) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
