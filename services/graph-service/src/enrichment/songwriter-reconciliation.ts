import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { reconcileWroteEdges } from '../db/songwriter-reconciliation-repository.js';

export interface SongwriterReconciliationSummary {
  linksReconciled: number;
  failed: number;
  durationMs: number;
}

/**
 * Promote each Work's captured writer MBIDs to `(:Artist|:Musician)-[:WROTE]->(:Work)` edges by
 * joining on the `musicbrainzId` the mb-artist-id pass stored (issue #380). Pure graph computation —
 * no external API, no new MusicBrainz calls (the writer MBIDs are already on the Work nodes from
 * #336). Idempotent and re-runnable, so it picks up newly-resolved MBIDs / newly-captured Works.
 *
 * **Errors propagate (it does NOT swallow them).** Each pass is a single all-or-nothing MERGE, so
 * on failure the orchestrator records the reload stage `failed` — keeping it out of `doneStages`
 * (a resumed reload re-runs it) and out of `ranStages` (the worksWithWriterLinks verify gate
 * self-exempts as not-run rather than false-failing). `failed` stays in the summary (always 0 here)
 * only to keep the pipeline counts shape uniform with the other stages.
 */
export async function enrichSongwriterReconciliation(
  driver: Driver,
  logger?: Logger,
): Promise<SongwriterReconciliationSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();

  log.info(
    '[songwriter-reconciliation] Linking Work writers → WROTE edges by shared musicbrainzId',
  );
  const linksReconciled = await reconcileWroteEdges(driver);
  log.info(`[songwriter-reconciliation] Ensured ${linksReconciled} WROTE edges`);

  return { linksReconciled, failed: 0, durationMs: Date.now() - startTime };
}
