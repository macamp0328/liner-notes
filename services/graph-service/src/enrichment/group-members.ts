import type { Driver } from 'neo4j-driver';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import {
  getGroupCandidates,
  setGroupMembers,
  markNotAGroup,
  type GroupCandidate,
  type GroupMember,
} from '../db/group-members-repository.js';
import {
  runEnrichment,
  TERMINAL_EMPTY,
  type EnrichmentStage,
  type EnrichmentSummary,
} from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export type GroupMembersEnrichmentSummary = EnrichmentSummary;

/** Roster resolved from a Discogs group profile; TERMINAL_EMPTY when the entity has no members (not a group). */
type ResolvedMembers = { members: GroupMember[] };

/**
 * Write `MEMBER_OF` group membership from Discogs `members[]` (issue #330). For every Musician node
 * carrying a discogsId whose last check has aged past the staleness window, fetches
 * `GET /artists/{id}` and — when the profile lists members — links each member's existing Musician
 * node to the group via `(member)-[:MEMBER_OF {active}]->(group)`. The motivating groups (e.g.
 * "Muscle Shoals Rhythm Section") are Musician-only credit nodes with no Artist node, so the
 * members source cannot be gated on the group being an Artist — it is fetched per Musician here.
 *
 * Group-ness is immutable, so a no-members result is TERMINAL, not throttled: `resolve` returns
 * `TERMINAL_EMPTY`, `markNotAGroup` writes the permanent `notAGroup` marker, and the runner counts
 * it `exhausted` (#367) — the node is never re-fetched. There is no throttled-recheck path here, so
 * the stage declares `markTerminal` and omits `markAttempted`. Member linking is MATCH-only —
 * members not credited anywhere are skipped, never created. Per-fetch errors are caught and counted.
 */
export async function enrichGroupMembers(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<GroupMembersEnrichmentSummary> {
  const log: Logger = logger ?? console;

  const stage: EnrichmentStage<GroupCandidate, ResolvedMembers> = {
    name: 'group-members',
    selectCandidates: (d) => getGroupCandidates(d),
    async resolve(candidate) {
      const profile = await client.getArtist(candidate.discogsId);
      // id === 0 is an uncatalogued Discogs entry with no stable node key — never linkable.
      const members: GroupMember[] = (profile.members ?? [])
        .filter((m) => m.id !== 0)
        .map((m) => ({ id: m.id, active: m.active }));
      // Resolves data whenever Discogs lists ANY member, so `enriched` counts
      // groups-with-members-listed, NOT MEMBER_OF edges actually written — a group whose members are
      // all uncollected (MATCH-only writes 0 edges) still counts enriched. The authoritative linkage
      // yield is /stats.memberOfEdges / groupsWithMembers; watch those after the first prod run
      // (#330 review). No members → TERMINAL_EMPTY: group-ness is immutable, so this is permanent.
      return members.length === 0 ? TERMINAL_EMPTY : { members };
    },
    write: (d, candidate, resolved) => setGroupMembers(d, candidate.discogsId, resolved.members),
    // Writes the permanent notAGroup marker (+ membersFetchedAt) so the non-group is never
    // re-fetched. No markAttempted: a no-members result is always terminal, never throttled.
    markTerminal: (d, candidate) => markNotAGroup(d, candidate.discogsId),
    describeItem: (candidate) => `group ${candidate.discogsId}`,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
