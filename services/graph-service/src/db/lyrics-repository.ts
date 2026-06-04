import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedTrack {
  title: string;
  position: string;
  releaseDiscogsId: number;
  artistName: string | null;
}

/**
 * Query Track nodes that still have no lyrics and whose last attempt has aged past the
 * staleness window (issue #89). Unlike the other enrichments, lyrics has no successful
 * data to gate on beyond `lyrics IS NULL`; `lyricsFetchedAt` throttles re-attempts of
 * still-empty tracks to once per window instead of every run (LRCLIB/Genius coverage may
 * improve, so a track is never given up on permanently — just throttled).
 * Returns artist name from the Release's RELEASED_BY relationship (first artist when multiple).
 */
export async function getUnenrichedTracks(driver: Driver): Promise<UnenrichedTrack[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
       WHERE t.lyrics IS NULL
         AND (t.lyricsFetchedAt IS NULL
              OR t.lyricsFetchedAt < datetime() - duration({ days: $stalenessDays }))
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH t, r, collect(a.name)[0] AS artistName
       RETURN t.title AS title, t.position AS position,
              t.releaseDiscogsId AS releaseDiscogsId, artistName`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((record) => {
      const rawId = record.get('releaseDiscogsId') as { toNumber(): number };
      return {
        title: record.get('title') as string,
        position: record.get('position') as string,
        releaseDiscogsId: rawId.toNumber(),
        artistName: record.get('artistName') as string | null,
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Update a Track node with lyrics and the source that provided them, stamping
 * `lyricsFetchedAt = datetime()` so a successful track is excluded by `lyrics IS NULL`
 * and the timestamp records the attempt.
 * Track is identified by the Release it belongs to (discogsId) and its position.
 */
export async function setTrackLyrics(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
  lyrics: string,
  lyricsSource: 'lrclib' | 'genius',
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.lyrics = $lyrics, t.lyricsSource = $lyricsSource, t.lyricsFetchedAt = datetime()`,
      {
        releaseDiscogsId: neo4j.int(releaseDiscogsId),
        position,
        lyrics,
        lyricsSource,
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp `lyricsFetchedAt = datetime()` on a Track without writing lyrics — used when a
 * lookup completed but found nothing (LRCLIB + Genius both empty, or no Genius token).
 * This throttles the next retry to one per staleness window instead of every run. Not
 * called on transient errors, so those still retry on the next run.
 * Track is identified by the Release it belongs to (discogsId) and its position.
 */
export async function markLyricsFetched(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.lyricsFetchedAt = datetime()`,
      { releaseDiscogsId: neo4j.int(releaseDiscogsId), position },
    );
  } finally {
    await session.close();
  }
}

/**
 * Null out all Track nodes enriched from Genius, including their `lyricsFetchedAt` stamp so
 * each cleared track becomes an immediate re-enrichment candidate rather than staying
 * throttled behind its old timestamp for the rest of the staleness window.
 * Returns the count of tracks cleared.
 */
export async function clearGeniusLyrics(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.lyricsSource = 'genius'
       SET t.lyrics = null, t.lyricsSource = null, t.lyricsFetchedAt = null
       RETURN count(t) AS cleared`,
    );
    const raw = result.records[0]?.get('cleared') as Neo4jInt | number | null | undefined;
    if (raw === null || raw === undefined) return 0;
    return typeof (raw as Neo4jInt).toNumber === 'function'
      ? (raw as Neo4jInt).toNumber()
      : (raw as number);
  } finally {
    await session.close();
  }
}
