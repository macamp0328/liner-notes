import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

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
 * Fetch every Track that has an `isrc` (set by the track-musicbrainz enrichment) but
 * still no Deezer data, plus any track whose last Deezer attempt has aged past the
 * staleness window (issue #89). A track that already carries `deezerBpm`/`deezerGain`
 * is never re-fetched; a track Deezer had no data for is retried at most once per window.
 *
 * Deezer is keyed purely by ISRC, so — unlike the MusicBrainz identifier enrichment —
 * no release context or tracklist alignment is needed.
 */
export async function getTracksForDeezerEnrichment(driver: Driver): Promise<TrackForDeezer[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.isrc IS NOT NULL
         AND t.deezerBpm IS NULL AND t.deezerGain IS NULL
         AND (t.deezerFetchedAt IS NULL
              OR t.deezerFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN elementId(t) AS elementId, t.isrc AS isrc`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
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
 * Every track in `results` is stamped with `deezerFetchedAt = datetime()` regardless of
 * whether Deezer had data — the timestamp throttles re-attempts to once per staleness
 * window. `deezerBpm` and `deezerGain` are set to their (possibly null) resolved values;
 * a null clears the property, matching the nullable-by-design contract.
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
       SET t.deezerFetchedAt = datetime(),
           t.deezerBpm = res.deezerBpm,
           t.deezerGain = res.deezerGain`,
      { results },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all Deezer enrichment from Track nodes: clears `deezerFetchedAt`, `deezerBpm`, and
 * `deezerGain` so the next enrichment run reprocesses every track. Returns the number of
 * tracks reset.
 */
export async function resetTrackDeezerEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track) WHERE t.deezerFetchedAt IS NOT NULL
       REMOVE t.deezerFetchedAt, t.deezerBpm, t.deezerGain
       RETURN count(t) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
