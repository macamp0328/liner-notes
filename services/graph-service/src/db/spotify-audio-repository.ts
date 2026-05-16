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

export interface TrackAudioFeatures {
  id: string;
  spotifyMatchConfidence: 'high' | 'medium';
  timeSignature: number;
  tempo: number;
  key: number;
  mode: number;
  loudness: number;
  energy: number;
  valence: number;
  danceability: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  speechiness: number;
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
 * Store Spotify audio features on a Track node.
 * Track is identified by its release (discogsId) and position within that release.
 */
export async function setTrackAudioFeatures(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
  features: TrackAudioFeatures,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.spotifyId = $spotifyId,
           t.spotifyMatchConfidence = $spotifyMatchConfidence,
           t.timeSignature = $timeSignature,
           t.tempo = $tempo,
           t.key = $key,
           t.mode = $mode,
           t.loudness = $loudness,
           t.energy = $energy,
           t.valence = $valence,
           t.danceability = $danceability,
           t.acousticness = $acousticness,
           t.instrumentalness = $instrumentalness,
           t.liveness = $liveness,
           t.speechiness = $speechiness`,
      {
        releaseDiscogsId: neo4j.int(releaseDiscogsId),
        position,
        spotifyId: features.id,
        spotifyMatchConfidence: features.spotifyMatchConfidence,
        timeSignature: neo4j.int(features.timeSignature),
        tempo: features.tempo,
        key: neo4j.int(features.key),
        mode: neo4j.int(features.mode),
        loudness: features.loudness,
        energy: features.energy,
        valence: features.valence,
        danceability: features.danceability,
        acousticness: features.acousticness,
        instrumentalness: features.instrumentalness,
        liveness: features.liveness,
        speechiness: features.speechiness,
      },
    );
  } finally {
    await session.close();
  }
}
