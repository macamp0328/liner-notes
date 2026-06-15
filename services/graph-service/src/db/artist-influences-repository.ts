import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/**
 * Project each Artist's captured P737 influences into in-collection `INFLUENCED_BY` edges (issue
 * #391). Pure graph computation — no external API. For every Artist carrying an `influencedByQids`
 * list (the raw Wikidata target QIDs the `artist-wikidata` pass stored), `UNWIND` it and `MATCH` a
 * target Artist by `wikidataQid`. The `MATCH` IS the confidence gate: a target QID we don't own
 * resolves to no node and is silently dropped (deterministic QID join, never a name match). Edges
 * are tagged `source:"wikidata"` for provenance, matching the `ORIGIN_COUNTRY {source}` convention.
 *
 * Idempotent and re-runnable (MERGE), so a re-run picks up newly-resolved targets without a
 * re-ingest. `target <> src` drops a self-influence (Wikidata occasionally lists one). Returns the
 * number of `INFLUENCED_BY` edges ensured.
 */
export async function linkInfluencedBy(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (src:Artist) WHERE src.influencedByQids IS NOT NULL
       UNWIND src.influencedByQids AS targetQid
       MATCH (target:Artist {wikidataQid: targetQid})
       WHERE target <> src
       MERGE (src)-[rel:INFLUENCED_BY]->(target)
       SET rel.source = 'wikidata'
       RETURN count(rel) AS linked`,
    );
    return (result.records[0]?.get('linked') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
