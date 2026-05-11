import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedArtist {
  discogsId: number;
}

/**
 * Return Artist nodes that have a discogsId but no profile property yet.
 * Various-artists placeholder nodes (id 194, 355) are excluded.
 */
export async function getUnenrichedArtists(driver: Driver): Promise<UnenrichedArtist[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND a.profile IS NULL
         AND NOT a.discogsId IN [194, 355]
       RETURN a.discogsId AS discogsId`,
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt).toNumber(),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Set realName and profile on an Artist node identified by discogsId.
 * Passing null for either field stores null (explicit absence).
 */
export async function setArtistProfile(
  driver: Driver,
  discogsId: number,
  realName: string | null,
  profile: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (a:Artist {discogsId: $discogsId})
       SET a.realName = $realName, a.profile = $profile`,
      { discogsId: neo4j.int(discogsId), realName, profile },
    );
  } finally {
    await session.close();
  }
}
