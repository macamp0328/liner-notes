import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedMasters,
  mergeMasterData,
  setMasterFetchedAndOriginalYear,
  setMasterFetched,
  type UnenrichedMaster,
} from '../db/master-data-repository.js';
import type { CountryWithFormats } from '../db/master-data-repository.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export type MasterDataEnrichmentSummary = EnrichmentSummary;

/** Master metadata resolved from the Discogs master + versions endpoints. */
type ResolvedMasterData = {
  title: string;
  year: number;
  countriesWithFormats: CountryWithFormats[];
};

export async function enrichMasterData(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<MasterDataEnrichmentSummary> {
  const log: Logger = logger ?? console;

  const stage: EnrichmentStage<UnenrichedMaster, ResolvedMasterData> = {
    name: 'master-data',
    selectCandidates: (d) => getUnenrichedMasters(d),
    async resolve(master) {
      // Step 1: Get originalYear from master endpoint
      const masterRelease = await client.getMaster(master.masterDiscogsId);
      const year = masterRelease.year;

      if (!year || year <= 0) return null;

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

      return { title: masterRelease.title, year, countriesWithFormats };
    },
    async write(d, master, resolved) {
      // Write Master node + RELEASED_IN relationships, then mark all releases sharing
      // this master as done.
      await mergeMasterData(
        d,
        master.masterDiscogsId,
        resolved.title,
        resolved.year,
        resolved.countriesWithFormats,
      );
      await setMasterFetchedAndOriginalYear(d, master.releaseIds, resolved.year);
    },
    // The master exists but has no usable year — stamp its releases so it isn't re-fetched
    // until the staleness window expires.
    markAttempted: (d, master) => setMasterFetched(d, master.releaseIds),
    describeItem: (master) => `master ${master.masterDiscogsId}`,
    progressEveryItems: 10,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
