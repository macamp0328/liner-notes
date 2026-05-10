import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedRelease {
  discogsId: number;
  masterDiscogsId: number;
}

/**
 * Query Release nodes that have a masterDiscogsId but no originalYear yet.
 * Idempotent: already-enriched releases (originalYear IS NOT NULL) are excluded.
 */
export async function getUnenrichedReleases(driver: Driver): Promise<UnenrichedRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)
       WHERE r.masterDiscogsId IS NOT NULL AND r.originalYear IS NULL
       RETURN r.discogsId AS discogsId, r.masterDiscogsId AS masterDiscogsId`,
    );
    return result.records.map((record) => {
      const rawId = record.get('discogsId') as Neo4jInt;
      const rawMasterId = record.get('masterDiscogsId') as Neo4jInt;
      return {
        discogsId: rawId.toNumber(),
        masterDiscogsId: rawMasterId.toNumber(),
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Set originalYear on a Release node identified by discogsId.
 */
export async function setOriginalYear(
  driver: Driver,
  discogsId: number,
  originalYear: number,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $discogsId})
       SET r.originalYear = $originalYear`,
      {
        discogsId: neo4j.int(discogsId),
        originalYear: neo4j.int(originalYear),
      },
    );
  } finally {
    await session.close();
  }
}
