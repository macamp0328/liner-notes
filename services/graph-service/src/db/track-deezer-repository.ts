import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/** A Track node carrying an ISRC and awaiting Deezer enrichment. */
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
 * Fetch every Track that has an `isrc` (set by the track-musicbrainz enrichment) but no
 * `deezerFetched` marker.
 *
 * Deezer is keyed purely by ISRC, so — unlike the MusicBrainz identifier enrichment —
 * no release context or tracklist alignment is needed.
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
 * Every track in `results` is marked `deezerFetched = true` regardless of whether Deezer
 * had data — the marker is the idempotency guard. `deezerBpm` and `deezerGain` are set to
 * their (possibly null) resolved values; a null clears the property, matching the
 * nullable-by-design contract.
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

/**
 * Remove all Deezer enrichment from Track nodes: clears `deezerFetched`, `deezerBpm`, and
 * `deezerGain` so the next enrichment run reprocesses every track. Returns the number of
 * tracks reset.
 */
export async function resetTrackDeezerEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track) WHERE t.deezerFetched IS NOT NULL
       REMOVE t.deezerFetched, t.deezerBpm, t.deezerGain
       RETURN count(t) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
