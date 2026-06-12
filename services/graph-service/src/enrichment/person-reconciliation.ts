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
 * order-dependent inline `mergeSamePersonAs` missed. Errors are caught and reported (never thrown)
 * so a reload stage records `failed` rather than aborting the run.
 */
export async function enrichPersonReconciliation(
  driver: Driver,
  logger?: Logger,
): Promise<PersonReconciliationSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let linksReconciled = 0;
  let failed = 0;

  log.info('[person-reconciliation] Linking Musician → Artist by shared discogsId');

  try {
    linksReconciled = await reconcileSamePersonLinks(driver);
    log.info(`[person-reconciliation] Ensured ${linksReconciled} SAME_PERSON_AS links`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[person-reconciliation] Failed: ${msg}`);
    failed = 1;
  }

  return { linksReconciled, failed, durationMs: Date.now() - startTime };
}
