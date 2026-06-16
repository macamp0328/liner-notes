import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { linkInfluencedBy, countInfluenceCandidates } from '../db/artist-influences-repository.js';

export interface ArtistInfluencesSummary {
  influencedByLinks: number;
  // #419 resolution denominator: total captured P737 references the join drew from. The ratio
  // influencedByLinks/influencedByCandidates is the in-collection hit rate.
  influencedByCandidates: number;
  failed: number;
  durationMs: number;
}

/**
 * Project captured Wikidata P737 influences into in-collection `INFLUENCED_BY` edges (issue #391).
 * Second pass to `artist-wikidata`'s first: that pass stores each Artist's raw `influencedByQids`,
 * this one resolves them against the stored `wikidataQid` (the deterministic QID join) — so it must
 * run after every QID is in place (`deps: ['artist-wikidata']`). Pure graph computation, no external
 * API. Idempotent and safe to re-run. Also reports the candidate denominator — total captured P737
 * references — so a low edge count is self-explaining in the reload output (#419).
 *
 * **Errors propagate (it does NOT swallow them).** The MERGE is all-or-nothing and the candidate
 * count that follows is a pure read; either throwing lets the orchestrator's catch record the reload
 * stage `failed` (out of `doneStages`, so a resumed reload re-runs it — both steps are idempotent)
 * without aborting the run. `failed` stays in the summary (always 0 here) only to keep the pipeline
 * counts shape uniform, matching `person-reconciliation`.
 */
export async function enrichArtistInfluences(
  driver: Driver,
  logger?: Logger,
): Promise<ArtistInfluencesSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();

  log.info('[artist-influences] Linking Artist → Artist INFLUENCED_BY from Wikidata P737');
  const influencedByLinks = await linkInfluencedBy(driver);
  const influencedByCandidates = await countInfluenceCandidates(driver);
  log.info(
    `[artist-influences] Ensured ${influencedByLinks} INFLUENCED_BY edges from ${influencedByCandidates} captured P737 references`,
  );

  return {
    influencedByLinks,
    influencedByCandidates,
    failed: 0,
    durationMs: Date.now() - startTime,
  };
}
