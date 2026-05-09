import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import { getUnenrichedReleases, setOriginalYear } from '../db/original-year-repository.js';

export interface OriginalYearEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Enrich Release nodes that have a masterDiscogsId but no originalYear.
 * Fetches GET /masters/{masterDiscogsId} for each and stores the year as originalYear.
 * Rate limiting is handled by DiscogsClient internally (same delay as ingestion).
 * Per-release errors are caught and counted — never crashes the caller.
 */
export async function enrichOriginalYear(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
): Promise<OriginalYearEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[original-year] Starting originalYear enrichment');

  const releases = await getUnenrichedReleases(driver);
  log.info(`[original-year] Found ${releases.length} releases without originalYear`);

  for (const release of releases) {
    try {
      const master = await client.getMaster(release.masterDiscogsId);

      if (!master.year || master.year <= 0) {
        log.warn(
          `[original-year] Master ${release.masterDiscogsId} returned no usable year — skipping release ${release.discogsId}`,
        );
        skipped++;
        continue;
      }

      await setOriginalYear(driver, release.discogsId, master.year);
      enriched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `[original-year] Failed for release ${release.discogsId} (master ${release.masterDiscogsId}): ${msg}`,
      );
      failed++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[original-year] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
