import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

export interface UnenrichedTrack {
  title: string;
  position: string;
  releaseDiscogsId: number;
  artistName: string | null;
}

/**
 * Query all Track nodes where lyrics is null.
 * Returns artist name from the Release's RELEASED_BY relationship (first artist when multiple).
 */
export async function getUnenrichedTracks(driver: Driver): Promise<UnenrichedTrack[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
       WHERE t.lyrics IS NULL
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH t, r, collect(a.name)[0] AS artistName
       RETURN t.title AS title, t.position AS position,
              t.releaseDiscogsId AS releaseDiscogsId, artistName`,
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
 * Update a Track node with lyrics and the source that provided them.
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
       SET t.lyrics = $lyrics, t.lyricsSource = $lyricsSource`,
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
