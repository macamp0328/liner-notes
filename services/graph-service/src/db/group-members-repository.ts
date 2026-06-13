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
 * Musician nodes carrying a discogsId that still need a Discogs `/artists/{id}` members[] check
 * (issue #330). Two disjoint sets qualify, and confirmed non-groups are permanently excluded:
 *
 *   1. **Never checked** (`membersFetchedAt IS NULL`) — the first sweep fetches every
 *      Musician-with-discogsId, since group-ness is unknowable without the fetch.
 *   2. **Known group, gone stale** — a node Discogs DID return members[] for (so `notAGroup` was
 *      never set) whose last check has aged past the staleness window, re-checked for lineup changes.
 *
 * Confirmed non-groups never re-qualify: when Discogs returns no members[], `stampMembersFetched`
 * sets a permanent `notAGroup = true` marker (group-ness is immutable — a person never becomes a
 * group), so the ~2.9k non-groups are checked exactly ONCE instead of re-confirmed every window
 * (~49 min of Discogs calls saved per sweep). A group whose members are all uncollected keeps
 * `notAGroup` unset (it IS a group, just edge-less for now), so it stays in the staleness re-check
 * and backfills MEMBER_OF edges as those members are later collected.
 *
 * This terminal-skip (`notAGroup`) vs. throttled-recheck (`membersFetchedAt`) split is the same
 * two-state shape `lyrics` uses (`instrumental`/`probable-instrumental` vs `lyricsFetchedAt`);
 * generalising it across every enrichment source is tracked in #367.
 */
export async function getGroupCandidates(driver: Driver): Promise<GroupCandidate[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Musician)
       WHERE m.discogsId IS NOT NULL
         AND m.notAGroup IS NULL
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
 * member matches, so a group whose members are all uncollected is not re-fetched every run. A
 * roster entry pointing at the group itself (`m <> group`) is skipped so no self-loop is created.
 *
 * `active` is stored but is NOT a tenure signal: Discogs members[] carries no join/leave dates, so
 * `MEMBER_OF` attributes a member to ALL of a group's work regardless of when they were in the
 * lineup (fine for stable session collectives, lossy for bands with changing rosters). No explore
 * query reads `active` today; date-qualified membership is roadmapped (#339 MB membership dates,
 * #341 Wikidata P463 begin/end) — until then the member→group expansion in getReleasesByMusician is
 * documented as an inferred involvement, not ground truth.
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
       WHERE m <> group
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
 * Stamp a Musician that Discogs returned no members[] for. Sets BOTH the staleness marker
 * `membersFetchedAt` AND the permanent `notAGroup = true` flag: this is the markAttempted path,
 * reached only when `resolve` returned null, so the node is a person, not a group. `notAGroup`
 * drops it out of `getGroupCandidates` for good (group-ness is immutable), turning the ~2.9k
 * non-groups from a per-window re-confirm into a one-time check. No MEMBER_OF edges are written.
 */
export async function stampMembersFetched(driver: Driver, discogsId: number): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (m:Musician {discogsId: $discogsId})
       SET m.membersFetchedAt = datetime(), m.notAGroup = true`,
      { discogsId: neo4j.int(discogsId) },
    );
  } finally {
    await session.close();
  }
}

/**
 * Delete every MEMBER_OF relationship and clear BOTH members markers — the `membersFetchedAt`
 * staleness stamp and the permanent `notAGroup` non-group flag — from all Musician nodes, so the
 * next `enrichGroupMembers` run re-fetches every group from scratch, including the confirmed
 * non-groups `notAGroup` would otherwise skip forever. Returns the number of Musician nodes whose
 * markers were cleared.
 */
export async function resetGroupMembers(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    await session.run('MATCH (:Musician)-[r:MEMBER_OF]->(:Musician) DELETE r');
    const result = await session.run(
      `MATCH (m:Musician) WHERE m.membersFetchedAt IS NOT NULL OR m.notAGroup IS NOT NULL
       REMOVE m.membersFetchedAt, m.notAGroup
       RETURN count(m) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
