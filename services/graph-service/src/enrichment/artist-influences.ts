import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { linkInfluencedBy } from '../db/artist-influences-repository.js';

export interface ArtistInfluencesSummary {
  influencedByLinks: number;
  failed: number;
  durationMs: number;
}

/**
 * Project captured Wikidata P737 influences into in-collection `INFLUENCED_BY` edges (issue #391).
 * Second pass to `artist-wikidata`'s first: that pass stores each Artist's raw `influencedByQids`,
 * this one resolves them against the stored `wikidataQid` (the deterministic QID join) — so it must
 * run after every QID is in place (`deps: ['artist-wikidata']`). Pure graph computation, no external
 * API. Idempotent and safe to re-run.
 *
 * **Errors propagate (it does NOT swallow them).** This is a single all-or-nothing MERGE, so on
 * failure the orchestrator's catch records the reload stage `failed` (out of `doneStages`, so a
 * resumed reload re-runs it) without aborting the run. `failed` stays in the summary (always 0 here)
 * only to keep the pipeline counts shape uniform, matching `person-reconciliation`.
 */
export async function enrichArtistInfluences(
  driver: Driver,
  logger?: Logger,
): Promise<ArtistInfluencesSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();

  log.info('[artist-influences] Linking Artist → Artist INFLUENCED_BY from Wikidata P737');
  const influencedByLinks = await linkInfluencedBy(driver);
  log.info(`[artist-influences] Ensured ${influencedByLinks} INFLUENCED_BY edges`);

  return { influencedByLinks, failed: 0, durationMs: Date.now() - startTime };
}
