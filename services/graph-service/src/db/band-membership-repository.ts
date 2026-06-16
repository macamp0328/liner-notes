import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/**
 * Project each Artist's captured P463 band memberships into dated in-collection
 * `MEMBER_OF {source:"wikidata"}` edges (issue #392). Pure graph computation — no external API. For
 * every Artist carrying a `memberOfQids` list (the index-aligned group QIDs + `memberOfSinceYears` /
 * `memberOfUntilYears` the `artist-wikidata` pass stored), `UNWIND` the array indices and `MATCH` the
 * group Artist by `wikidataQid`. The `MATCH` IS the confidence gate: a group QID we don't own resolves
 * to no node and is silently dropped (deterministic QID join, never a name match). Edges are tagged
 * `source:"wikidata"` for provenance.
 *
 * This Artist→Artist edge is DISTINCT from the Discogs `(:Musician)-[:MEMBER_OF {active}]->(:Musician)`
 * edge (#330): different node labels, different properties (`source`/`since`/`until` vs `active`), so
 * the two never collide on MERGE and both survive with provenance — the issue's "keep both" rule.
 *
 * `since`/`until` are the start/end YEAR (P580/P582); the `0` sentinel (Wikidata had no qualifier)
 * stores no property, leaving the edge date-less. Years are read straight off the node as Neo4j ints.
 *
 * Idempotent and re-runnable (MERGE), so a re-run picks up newly-resolved groups without a re-ingest
 * and updates a changed tenure in place. `grp <> src` drops a self-membership. Returns the number of
 * `MEMBER_OF` edges ensured.
 *
 * NOTE (multi-tenure): the MERGE key is `{source:"wikidata"}` between the two nodes, so two separate
 * tenures in the same band collapse onto one edge with last-write-wins dates. Acceptable for v1 (the
 * issue asks for begin/end dates, singular); representing multiple tenures would need a composite key
 * that includes the years — a deliberate follow-up.
 */
export async function linkBandMemberships(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (src:Artist) WHERE src.memberOfQids IS NOT NULL
       UNWIND range(0, size(src.memberOfQids) - 1) AS i
       WITH src, src.memberOfQids[i] AS groupQid,
            src.memberOfSinceYears[i] AS sinceYear, src.memberOfUntilYears[i] AS untilYear
       MATCH (grp:Artist {wikidataQid: groupQid})
       WHERE grp <> src
       MERGE (src)-[rel:MEMBER_OF {source: 'wikidata'}]->(grp)
       SET rel.since = CASE WHEN sinceYear = 0 THEN null ELSE sinceYear END,
           rel.until = CASE WHEN untilYear = 0 THEN null ELSE untilYear END
       RETURN count(rel) AS linked`,
    );
    return (result.records[0]?.get('linked') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
