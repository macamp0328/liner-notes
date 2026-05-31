import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedArtist {
  discogsId: number;
}

/**
 * Return Artist nodes that have a discogsId but have not yet been enriched
 * with profile data. Various-artists placeholder nodes (id 194, 355) are excluded.
 *
 * Uses profileFetched as an explicit enrichment marker rather than checking
 * profile IS NULL — Neo4j removes null properties on SET, so a null profile
 * would otherwise cause the artist to be re-fetched every run.
 */
export async function getUnenrichedArtists(driver: Driver): Promise<UnenrichedArtist[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND a.profileFetched IS NULL
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
 * Also sets profileFetched = true as an idempotency marker — this ensures
 * getUnenrichedArtists will not return this artist again even when profile is
 * absent (Neo4j removes null properties on SET, so profile IS NULL is
 * indistinguishable from never having been fetched).
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
       SET a.realName = $realName, a.profile = $profile, a.profileFetched = true`,
      { discogsId: neo4j.int(discogsId), realName, profile },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove the profile-enrichment marker and data (profileFetched, realName,
 * profile) from every Artist node that carries it, causing the next
 * enrichArtistProfiles run to re-fetch all artists from scratch.
 * Returns the number of Artist nodes reset.
 */
export async function resetArtistProfilesEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist) WHERE a.profileFetched IS NOT NULL
       REMOVE a.profileFetched, a.realName, a.profile
       RETURN count(a) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
