import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedArtist {
  discogsId: number;
}

/**
 * Return Artist nodes that have a discogsId but still no profile data (neither realName
 * nor profile), and whose last attempt has aged past the staleness window (issue #89).
 * Various-artists placeholder nodes (id 194, 355) are excluded. An artist that already has
 * a realName or profile is never re-fetched; one Discogs had nothing for is retried at most
 * once per window. `profileFetchedAt` throttles those retries (Discogs returns "" / null for
 * absent fields, which Neo4j stores as a removed property, so the data check alone would
 * re-fetch every run).
 */
export async function getUnenrichedArtists(driver: Driver): Promise<UnenrichedArtist[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND a.realName IS NULL AND a.profile IS NULL
         AND NOT a.discogsId IN [194, 355]
         AND (a.profileFetchedAt IS NULL
              OR a.profileFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN a.discogsId AS discogsId`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
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
 * Also stamps profileFetchedAt = datetime() — when Discogs had neither field, this
 * timestamp throttles the next retry to one per staleness window rather than every run
 * (Neo4j removes null properties on SET, so an absent profile is indistinguishable from
 * never having been fetched without the timestamp).
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
       SET a.realName = $realName, a.profile = $profile, a.profileFetchedAt = datetime()`,
      { discogsId: neo4j.int(discogsId), realName, profile },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove the profile-enrichment marker and data (profileFetchedAt, realName,
 * profile) from every Artist node that carries it, causing the next
 * enrichArtistProfiles run to re-fetch all artists from scratch.
 * Returns the number of Artist nodes reset.
 */
export async function resetArtistProfilesEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist) WHERE a.profileFetchedAt IS NOT NULL
       REMOVE a.profileFetchedAt, a.realName, a.profile
       RETURN count(a) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
