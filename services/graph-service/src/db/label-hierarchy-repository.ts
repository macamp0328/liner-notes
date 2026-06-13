import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedLabel {
  discogsId: number;
}

/** A label's parent, resolved from the Discogs label endpoint. */
export interface LabelParent {
  discogsId: number;
  name: string;
}

/**
 * Return Label nodes whose parent hierarchy is due a fetch (issue #332). Bounded to labels that
 * are actually referenced by a Release (`ON_LABEL`): the parent hub nodes this enrichment creates
 * carry no incoming ON_LABEL, so they are never selected — keeping the candidate set to the few
 * hundred labels in the collection rather than recursing up the entire Discogs label graph.
 *
 * Gated purely by `labelHierarchyFetchedAt`, not a data-existence check: a label may legitimately
 * have no parent, so the timestamp alone throttles re-fetches to once per staleness window (#89),
 * which also catches a label that gains or changes a parent on Discogs later.
 */
export async function getUnenrichedLabels(driver: Driver): Promise<UnenrichedLabel[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (l:Label)
       WHERE l.discogsId IS NOT NULL
         AND EXISTS { (l)<-[:ON_LABEL]-(:Release) }
         AND (l.labelHierarchyFetchedAt IS NULL
              OR l.labelHierarchyFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN l.discogsId AS discogsId`,
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
 * Point a child Label at its parent and stamp labelHierarchyFetchedAt. A label has exactly one
 * parent, so any existing outgoing PARENT_LABEL is deleted first to reconcile a re-parent. The
 * parent node is MERGEd by discogsId (it may not yet exist in the collection — it becomes a hub
 * connecting the family). Caller guards against self-parenting before reaching here.
 */
export async function setLabelParent(
  driver: Driver,
  childDiscogsId: number,
  parent: LabelParent,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (child:Label {discogsId: $childId})
       OPTIONAL MATCH (child)-[old:PARENT_LABEL]->(:Label)
       DELETE old
       WITH child
       MERGE (parent:Label {discogsId: $parentId})
         ON CREATE SET parent.name = $parentName
         ON MATCH SET parent.name = coalesce($parentName, parent.name)
       MERGE (child)-[:PARENT_LABEL]->(parent)
       SET child.labelHierarchyFetchedAt = datetime()`,
      {
        childId: neo4j.int(childDiscogsId),
        parentId: neo4j.int(parent.discogsId),
        parentName: parent.name,
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp labelHierarchyFetchedAt without recording a parent — the markAttempted path for a label
 * Discogs reports as having no parent. Also removes any stale outgoing PARENT_LABEL so a label
 * that LOST its parent on Discogs is reconciled, not left pointing at a former parent.
 */
export async function setLabelHierarchyFetched(
  driver: Driver,
  childDiscogsId: number,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (child:Label {discogsId: $childId})
       OPTIONAL MATCH (child)-[old:PARENT_LABEL]->(:Label)
       DELETE old
       WITH child
       SET child.labelHierarchyFetchedAt = datetime()`,
      { childId: neo4j.int(childDiscogsId) },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove the labelHierarchyFetchedAt marker from every Label and delete all PARENT_LABEL edges,
 * so the next enrichLabelHierarchy run re-fetches every label from scratch. Returns the number of
 * marked Label nodes reset.
 *
 * Note: parent hub nodes created for parents not in the collection are left behind (now edgeless
 * and harmless); a full from-scratch cleanup is `POST /admin/reset?confirm=wipe-all`.
 */
export async function resetLabelHierarchyEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (l:Label) WHERE l.labelHierarchyFetchedAt IS NOT NULL
       REMOVE l.labelHierarchyFetchedAt
       WITH l
       OPTIONAL MATCH (l)-[p:PARENT_LABEL]->(:Label)
       DELETE p
       RETURN count(DISTINCT l) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
