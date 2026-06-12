import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/**
 * Reconcile person identities: link every Musician carrying a discogsId to the Artist node sharing
 * that discogsId via SAME_PERSON_AS (issue #330). Standalone and idempotent, so it backfills links
 * the inline `mergeSamePersonAs` missed because the Artist node arrived via a later release.
 * `Artist.discogsId` is unique, so each reconcilable Musician links to exactly one Artist. Returns
 * the number of SAME_PERSON_AS links ensured.
 */
export async function reconcileSamePersonLinks(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Musician) WHERE m.discogsId IS NOT NULL
       MATCH (a:Artist {discogsId: m.discogsId})
       MERGE (m)-[rel:SAME_PERSON_AS]->(a)
       RETURN count(rel) AS linked`,
    );
    return (result.records[0]?.get('linked') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
