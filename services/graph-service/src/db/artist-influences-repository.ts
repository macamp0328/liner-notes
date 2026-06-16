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

/**
 * Count the total captured Wikidata P737 "influenced by" references across all Artists (issue #419) —
 * the resolution input {@link linkInfluencedBy} projects from. A QID repeated across artists counts
 * each time, so this is the true denominator for the resolved `INFLUENCED_BY` edge count: a low edge
 * count reads as "N of M references were in-collection" instead of needing a manual prod query. Pure
 * read; `coalesce` keeps it 0 over an empty graph (sum over zero matched rows would otherwise be
 * null). Mirrors `INFLUENCED_BY_CANDIDATES_QUERY` in stats-repository — both compute the same #419
 * denominator, one for `/stats`, this one for the stage's reload output.
 */
export async function countInfluenceCandidates(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist) WHERE a.influencedByQids IS NOT NULL
       RETURN coalesce(sum(size(a.influencedByQids)), 0) AS candidates`,
    );
    return (result.records[0]?.get('candidates') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
