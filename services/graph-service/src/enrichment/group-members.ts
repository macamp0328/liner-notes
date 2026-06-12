import type { Driver } from 'neo4j-driver';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import {
  getGroupCandidates,
  setGroupMembers,
  stampMembersFetched,
  type GroupCandidate,
  type GroupMember,
} from '../db/group-members-repository.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export type GroupMembersEnrichmentSummary = EnrichmentSummary;

/** Roster resolved from a Discogs group profile; null when the entity has no members (not a group). */
type ResolvedMembers = { members: GroupMember[] };

/**
 * Write `MEMBER_OF` group membership from Discogs `members[]` (issue #330). For every Musician node
 * carrying a discogsId whose last check has aged past the staleness window, fetches
 * `GET /artists/{id}` and — when the profile lists members — links each member's existing Musician
 * node to the group via `(member)-[:MEMBER_OF {active}]->(group)`. The motivating groups (e.g.
 * "Muscle Shoals Rhythm Section") are Musician-only credit nodes with no Artist node, so the
 * members source cannot be gated on the group being an Artist — it is fetched per Musician here.
 *
 * Group-ness is not knowable without the fetch, so non-groups are stamped (`membersFetchedAt`) and
 * counted `skipped`, re-checked at most once per window. Member linking is MATCH-only — members not
 * credited anywhere are skipped, never created. Per-fetch errors are caught and counted.
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
      return members.length === 0 ? null : { members };
    },
    write: (d, candidate, resolved) => setGroupMembers(d, candidate.discogsId, resolved.members),
    // Stamps membersFetchedAt with no edges, throttling re-checks of non-group musicians.
    markAttempted: (d, candidate) => stampMembersFetched(d, candidate.discogsId),
    describeItem: (candidate) => `group ${candidate.discogsId}`,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
