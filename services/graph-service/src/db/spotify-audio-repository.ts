import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

function toNum(v: unknown): number {
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return v as number;
}

export interface SpotifyTrackCandidate {
  title: string;
  position: string;
  releaseDiscogsId: number;
  artistName: string | null;
  durationSeconds: number;
}

/**
 * Query Track nodes that have a known duration but no Spotify audio features yet.
 * Excludes tracks without durationSeconds — duration proximity is required for match confirmation.
 */
export async function getTracksForSpotifyEnrichment(
  driver: Driver,
): Promise<SpotifyTrackCandidate[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
       WHERE t.spotifyId IS NULL AND t.durationSeconds IS NOT NULL
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH t, r, collect(a.name)[0] AS artistName
       RETURN t.title AS title, t.position AS position,
              t.releaseDiscogsId AS releaseDiscogsId,
              t.durationSeconds AS durationSeconds,
              artistName`,
    );
    return result.records.map((record) => {
      return {
        title: record.get('title') as string,
        position: record.get('position') as string,
        releaseDiscogsId: toNum(record.get('releaseDiscogsId')),
        durationSeconds: toNum(record.get('durationSeconds')),
        artistName: record.get('artistName') as string | null,
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Store the Spotify track ID and match confidence on a Track node.
 * Track is identified by its release (discogsId) and position within that release.
 */
export async function setTrackSpotifyId(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
  spotifyId: string,
  confidence: 'high' | 'medium',
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.spotifyId = $spotifyId,
           t.spotifyMatchConfidence = $spotifyMatchConfidence`,
      {
        releaseDiscogsId: neo4j.int(releaseDiscogsId),
        position,
        spotifyId,
        spotifyMatchConfidence: confidence,
      },
    );
  } finally {
    await session.close();
  }
}
