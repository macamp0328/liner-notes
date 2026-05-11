import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

export interface VersionTrack {
  elementId: string;
  title: string;
  releaseDiscogsId: number;
}

export interface VersionGroup {
  normalizedTitle: string;
  tracks: VersionTrack[];
}

/**
 * Find groups of Tracks that share a non-empty normalizedTitle across
 * different releases. Returns one VersionGroup per normalizedTitle with
 * 2+ tracks (at least one potential version pair).
 */
export async function getVersionCandidates(driver: Driver): Promise<VersionGroup[]> {
  const session = driver.session();
  try {
    // Cypher groups tracks by normalizedTitle via collect(); TypeScript filters
    // groups that span only a single release (no cross-release version pairs).
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.normalizedTitle IS NOT NULL AND t.normalizedTitle <> ''
       WITH t.normalizedTitle AS normalizedTitle,
            collect({elementId: elementId(t), title: t.title, releaseDiscogsId: t.releaseDiscogsId}) AS tracks
       WHERE size(tracks) > 1
       RETURN normalizedTitle, tracks`,
    );

    const groups: VersionGroup[] = [];

    for (const record of result.records) {
      const normalizedTitle = record.get('normalizedTitle') as string;
      const rawTracks = record.get('tracks') as Array<{
        elementId: string;
        title: string;
        releaseDiscogsId: Neo4jInt;
      }>;

      const tracks: VersionTrack[] = rawTracks.map((t) => ({
        elementId: t.elementId,
        title: t.title,
        releaseDiscogsId: t.releaseDiscogsId.toNumber(),
      }));

      // Only keep groups that span multiple releases
      const releaseIds = new Set(tracks.map((t) => t.releaseDiscogsId));
      if (releaseIds.size > 1) {
        groups.push({ normalizedTitle, tracks });
      }
    }

    return groups;
  } finally {
    await session.close();
  }
}

export interface VersionPair {
  fromElementId: string;
  toElementId: string;
  versionType: string;
}

/**
 * Create IS_VERSION_OF relationships for a set of track pairs.
 * Uses UNWIND to handle all pairs in one round-trip rather than looping.
 * MERGE is idempotent — re-runs update versionType in place.
 */
export async function mergeVersionRelationships(
  driver: Driver,
  pairs: VersionPair[],
): Promise<void> {
  if (pairs.length === 0) return;
  const session = driver.session();
  try {
    await session.run(
      `UNWIND $pairs AS pair
       MATCH (from:Track) WHERE elementId(from) = pair.fromId
       MATCH (to:Track)   WHERE elementId(to)   = pair.toId
       MERGE (from)-[r:IS_VERSION_OF]->(to)
       SET r.versionType = pair.versionType`,
      {
        pairs: pairs.map((p) => ({
          fromId: p.fromElementId,
          toId: p.toElementId,
          versionType: p.versionType,
        })),
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Check whether two releases share at least one Artist via RELEASED_BY.
 * Used to filter version candidates by artist overlap.
 */
export async function releasesShareArtist(
  driver: Driver,
  releaseIdA: number,
  releaseIdB: number,
): Promise<boolean> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r1:Release {discogsId: $idA})-[:RELEASED_BY]->(a:Artist)<-[:RELEASED_BY]-(r2:Release {discogsId: $idB})
       RETURN 1 AS found LIMIT 1`,
      { idA: neo4j.int(releaseIdA), idB: neo4j.int(releaseIdB) },
    );
    return result.records.length > 0;
  } finally {
    await session.close();
  }
}
