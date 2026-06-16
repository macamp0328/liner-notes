import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { linkBandMemberships } from '../db/band-membership-repository.js';

export interface BandMembershipSummary {
  membershipLinks: number;
  failed: number;
  durationMs: number;
}

/**
 * Project captured Wikidata P463 band memberships into dated `MEMBER_OF {source:"wikidata"}` edges
 * (issue #392). Second pass to `artist-wikidata`'s first: that pass stores each Artist's index-aligned
 * `memberOfQids` / `memberOfSinceYears` / `memberOfUntilYears`, this one resolves the group QIDs
 * against the stored `wikidataQid` (the deterministic QID join) — so it must run after every QID is in
 * place (`deps: ['artist-wikidata']`). Pure graph computation, no external API. Idempotent and safe to
 * re-run. The resulting Artist→Artist edge is distinct from the Discogs Musician→Musician `MEMBER_OF`.
 *
 * **Errors propagate (it does NOT swallow them).** This is a single all-or-nothing MERGE, so on
 * failure the orchestrator's catch records the reload stage `failed` (out of `doneStages`, so a
 * resumed reload re-runs it) without aborting the run. `failed` stays in the summary (always 0 here)
 * only to keep the pipeline counts shape uniform, matching `artist-influences`.
 */
export async function enrichBandMemberships(
  driver: Driver,
  logger?: Logger,
): Promise<BandMembershipSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();

  log.info('[band-membership] Linking Artist → Artist MEMBER_OF from Wikidata P463');
  const membershipLinks = await linkBandMemberships(driver);
  log.info(`[band-membership] Ensured ${membershipLinks} MEMBER_OF (wikidata) edges`);

  return { membershipLinks, failed: 0, durationMs: Date.now() - startTime };
}
