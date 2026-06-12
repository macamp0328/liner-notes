import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/** A Musician node that should have its Discogs `/artists/{id}` members[] checked. */
export interface GroupCandidate {
  discogsId: number;
}

/** One roster entry from a Discogs group profile, narrowed to what MEMBER_OF needs. */
export interface GroupMember {
  id: number;
  active: boolean;
}

/**
 * Musician nodes carrying a discogsId whose last members lookup has aged past the staleness
 * window (issue #330). Group-ness is not knowable without fetching `/artists/{id}`, so the gate
 * is purely staleness-based: every Musician-with-discogsId is checked once per window and stamped
 * (groups get MEMBER_OF edges, non-groups just get the marker). `membersFetchedAt` throttles the
 * re-check to once per window rather than every run.
 */
export async function getGroupCandidates(driver: Driver): Promise<GroupCandidate[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Musician)
       WHERE m.discogsId IS NOT NULL
         AND (m.membersFetchedAt IS NULL
              OR m.membersFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN m.discogsId AS discogsId`,
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
 * Link each existing member Musician node to the group Musician node (sharing the group's
 * discogsId) via `MEMBER_OF { active }`, and stamp `membersFetchedAt` on the group.
 *
 * MATCH-only: a member not credited anywhere has no Musician node and is silently skipped — no
 * phantom nodes (the repo's deterministic-clean-data rule). The marker is stamped even when no
 * member matches, so a group whose members are all uncollected is not re-fetched every run.
 */
export async function setGroupMembers(
  driver: Driver,
  groupDiscogsId: number,
  members: GroupMember[],
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (group:Musician {discogsId: $groupDiscogsId})
       SET group.membersFetchedAt = datetime()
       WITH group
       UNWIND $members AS member
       MATCH (m:Musician {discogsId: member.id})
       MERGE (m)-[rel:MEMBER_OF]->(group)
       SET rel.active = member.active`,
      {
        groupDiscogsId: neo4j.int(groupDiscogsId),
        members: members.map((m) => ({ id: neo4j.int(m.id), active: m.active })),
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp `membersFetchedAt` on a Musician without writing any MEMBER_OF edges — the markAttempted
 * path for a node Discogs returned no members for (a non-group), throttling its re-check.
 */
export async function stampMembersFetched(driver: Driver, discogsId: number): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (m:Musician {discogsId: $discogsId})
       SET m.membersFetchedAt = datetime()`,
      { discogsId: neo4j.int(discogsId) },
    );
  } finally {
    await session.close();
  }
}

/**
 * Delete every MEMBER_OF relationship and clear the `membersFetchedAt` marker from all Musician
 * nodes, so the next `enrichGroupMembers` run re-fetches every group from scratch. Returns the
 * number of Musician nodes whose marker was cleared.
 */
export async function resetGroupMembers(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    await session.run('MATCH (:Musician)-[r:MEMBER_OF]->(:Musician) DELETE r');
    const result = await session.run(
      `MATCH (m:Musician) WHERE m.membersFetchedAt IS NOT NULL
       REMOVE m.membersFetchedAt
       RETURN count(m) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
