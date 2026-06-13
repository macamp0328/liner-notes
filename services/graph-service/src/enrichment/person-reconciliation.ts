import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { reconcileSamePersonLinks } from '../db/person-reconciliation-repository.js';

export interface PersonReconciliationSummary {
  linksReconciled: number;
  failed: number;
  durationMs: number;
}

/**
 * Reconcile Musician identities with Artist nodes by writing SAME_PERSON_AS links (issue #330).
 * Pure graph computation — no external API. Idempotent and re-runnable, so it picks up links the
 * order-dependent inline `mergeSamePersonAs` missed.
 *
 * **Errors propagate (it does NOT swallow them).** This is a single all-or-nothing MERGE, so on
 * failure the orchestrator's catch records the reload stage `failed` — which keeps it out of
 * `ranStages` (the `samePersonLinks` verify gate self-exempts as not-run rather than false-failing)
 * AND out of `doneStages` (so a resumed reload RE-RUNS it instead of skipping a half-done pass). A
 * throw does not abort the run — the orchestrator isolates it and continues the other stages.
 * `failed` stays in the summary (always 0 here) only to keep the pipeline counts shape uniform.
 */
export async function enrichPersonReconciliation(
  driver: Driver,
  logger?: Logger,
): Promise<PersonReconciliationSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();

  log.info('[person-reconciliation] Linking Musician → Artist by shared discogsId');
  const linksReconciled = await reconcileSamePersonLinks(driver);
  log.info(`[person-reconciliation] Ensured ${linksReconciled} SAME_PERSON_AS links`);

  return { linksReconciled, failed: 0, durationMs: Date.now() - startTime };
}
