import type { Driver } from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

// Promote each Work's captured writer MBIDs to WROTE edges by joining on the musicbrainzId the
// mb-artist-id pass stored (#380) — ID join only, never name-matching. One single-label MERGE per
// person label (index-friendly via artist_musicbrainz_id / musician_musicbrainz_id). The writer
// arrays are index-aligned (writerMbids[i] ↔ writerRoles[i]); a person credited as both composer
// and lyricist appears twice with the same MBID, so roles are grouped to one DISTINCT array on a
// single WROTE edge. `count(rel)` after MERGE counts every edge ensured (idempotent re-run).
function reconcileQuery(label: 'Artist' | 'Musician'): string {
  return `
    MATCH (w:Work) WHERE w.writerMbids IS NOT NULL
    UNWIND range(0, size(w.writerMbids) - 1) AS i
    WITH w, w.writerMbids[i] AS mbid, w.writerRoles[i] AS role
    WITH w, mbid, collect(DISTINCT role) AS roles
    MATCH (p:${label} {musicbrainzId: mbid})
    MERGE (p)-[rel:WROTE]->(w)
    SET rel.source = 'musicbrainz', rel.roles = roles
    RETURN count(rel) AS linked`;
}

const ARTIST_WROTE_QUERY = reconcileQuery('Artist');
const MUSICIAN_WROTE_QUERY = reconcileQuery('Musician');

async function runReconcile(driver: Driver, query: string): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(query);
    return (result.records[0]?.get('linked') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}

/**
 * Create `(:Artist|:Musician)-[:WROTE]->(:Work)` edges from each Work's captured `writerMbids`,
 * matching person nodes by the `musicbrainzId` resolved by the mb-artist-id pass (#380). Runs the
 * Artist and Musician passes (each a single idempotent MERGE) and returns the total edges ensured.
 * Both labels are linked so a songwriter that exists only as a primary Artist node still gets edges.
 */
export async function reconcileWroteEdges(driver: Driver): Promise<number> {
  const artistLinks = await runReconcile(driver, ARTIST_WROTE_QUERY);
  const musicianLinks = await runReconcile(driver, MUSICIAN_WROTE_QUERY);
  return artistLinks + musicianLinks;
}
