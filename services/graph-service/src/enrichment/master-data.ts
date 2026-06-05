import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedMasters,
  mergeMasterData,
  setMasterFetchedAndOriginalYear,
  setMasterFetched,
} from '../db/master-data-repository.js';
import type { CountryWithFormats } from '../db/master-data-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface MasterDataEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export async function enrichMasterData(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<MasterDataEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[master-data] Starting master data enrichment');

  let masters;
  try {
    masters = await getUnenrichedMasters(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[master-data] Failed to fetch unenriched masters: ${msg}`);
    return { enriched: 0, skipped: 0, failed: 1, durationMs: Date.now() - startTime };
  }

  const total = masters.length;
  log.info(`[master-data] Found ${total} masters to enrich`);
  onProgress(0, total);

  let processed = 0;
  for (const master of masters) {
    processed++;
    if (processed % 10 === 0) onProgress(processed, total);
    try {
      // Step 1: Get originalYear from master endpoint
      const masterRelease = await client.getMaster(master.masterDiscogsId);
      const year = masterRelease.year;

      if (!year || year <= 0) {
        await setMasterFetched(driver, master.releaseIds);
        skipped++;
        continue;
      }

      // Step 2: Paginate versions to collect all pressing countries + formats
      const countryFormats = new Map<string, Set<string>>();
      let page = 1;
      let totalPages = 1;

      do {
        const versionsPage = await client.getMasterVersions(master.masterDiscogsId, page, 100);
        totalPages = versionsPage.pagination.pages;

        for (const version of versionsPage.versions) {
          const country = version.country?.trim();
          if (!country) continue;

          if (!countryFormats.has(country)) {
            countryFormats.set(country, new Set());
          }
          for (const fmt of version.major_formats) {
            if (fmt.trim()) countryFormats.get(country)!.add(fmt.trim());
          }
        }

        page++;
      } while (page <= totalPages);

      const countriesWithFormats: CountryWithFormats[] = Array.from(countryFormats.entries()).map(
        ([country, formats]) => ({ country, formats: Array.from(formats) }),
      );

      // Step 3: Write Master node + RELEASED_IN relationships
      await mergeMasterData(
        driver,
        master.masterDiscogsId,
        masterRelease.title,
        year,
        countriesWithFormats,
      );

      // Step 4: Mark all releases sharing this master as done
      await setMasterFetchedAndOriginalYear(driver, master.releaseIds, year);

      enriched++;

      if (enriched % 10 === 0) {
        log.info(`[master-data] Progress: ${enriched} masters enriched`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[master-data] Failed for master ${master.masterDiscogsId}: ${msg}`);
      failed++;
    }
  }

  onProgress(total, total);
  const durationMs = Date.now() - startTime;
  log.info(
    `[master-data] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
