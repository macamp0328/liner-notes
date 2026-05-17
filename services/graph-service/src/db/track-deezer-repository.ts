import type { Driver } from 'neo4j-driver';

/** A Track node awaiting Deezer BPM/loudness enrichment. */
export interface TrackForDeezer {
  elementId: string;
  isrc: string;
}

/** The Deezer data resolved for a single Track. Both values are nullable. */
export interface TrackDeezerResult {
  elementId: string;
  deezerBpm: number | null;
  deezerGain: number | null;
}

/**
 * Fetch every Track that has an ISRC but has not yet been processed by Deezer enrichment.
 */
export async function getTracksForDeezerEnrichment(driver: Driver): Promise<TrackForDeezer[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.isrc IS NOT NULL AND t.deezerFetched IS NULL
       RETURN elementId(t) AS elementId, t.isrc AS isrc`,
    );

    return result.records.map((record) => ({
      elementId: record.get('elementId') as string,
      isrc: record.get('isrc') as string,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Write Deezer BPM and gain onto Track nodes and mark each as fetched.
 *
 * Every track in `results` is marked with deezerFetched = true regardless of
 * whether data was found — the marker is the idempotency guard. deezerBpm and
 * deezerGain are set to their (possibly null) resolved values.
 */
export async function setTrackDeezerData(
  driver: Driver,
  results: TrackDeezerResult[],
): Promise<void> {
  if (results.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $results AS res
       MATCH (t:Track) WHERE elementId(t) = res.elementId
       SET t.deezerFetched = true,
           t.deezerBpm = res.deezerBpm,
           t.deezerGain = res.deezerGain`,
      { results },
    );
  } finally {
    await session.close();
  }
}
