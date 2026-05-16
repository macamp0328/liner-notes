import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getMastersForReleaseEventEnrichment,
  mergeMbReleaseEvents,
  setMbReleaseEventsFetched,
} from '../db/mb-release-events-repository.js';

export interface MbReleaseEventsEnrichmentSummary {
  mastersProcessed: number;
  mastersSkipped: number;
  mastersFailed: number;
  eventsWritten: number;
  durationMs: number;
}

/**
 * Enrich Master nodes with MB_RELEASED_IN relationships to Country nodes.
 *
 * For each unenriched Master, walks: Discogs master ID → MB release group MBID →
 * paginated official releases → release events. Writes one MB_RELEASED_IN relationship
 * per event that has an ISO-3166-1 country code, keyed on mbReleaseId for idempotency.
 *
 * Sets mbReleaseEventsFetched = true on every successfully processed Master,
 * including those with no MB link. Failed masters are NOT marked so they are retried.
 */
export async function enrichMbReleaseEvents(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
): Promise<MbReleaseEventsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let mastersProcessed = 0;
  let mastersSkipped = 0;
  let mastersFailed = 0;
  let eventsWritten = 0;

  log.info('[mb-release-events] Starting MusicBrainz release event enrichment');

  let masters;
  try {
    masters = await getMastersForReleaseEventEnrichment(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[mb-release-events] Failed to fetch unenriched masters: ${msg}`);
    return {
      mastersProcessed: 0,
      mastersSkipped: 0,
      mastersFailed: 1,
      eventsWritten: 0,
      durationMs: Date.now() - startTime,
    };
  }

  log.info(`[mb-release-events] Found ${masters.length} masters without release events`);

  let i = 0;
  for (const { masterDiscogsId } of masters) {
    if (i > 0 && i % 10 === 0) {
      log.info(
        `[mb-release-events] Progress: ${i}/${masters.length} — processed=${mastersProcessed}, skipped=${mastersSkipped}, failed=${mastersFailed}, eventsWritten=${eventsWritten}`,
      );
    }
    i++;

    try {
      const mbid = await mbClient.getReleaseGroupMbidByMasterDiscogsId(masterDiscogsId);

      if (mbid === null) {
        log.info(`[mb-release-events] No MB link for master ${masterDiscogsId} — skipping`);
        mastersSkipped++;
        await setMbReleaseEventsFetched(driver, masterDiscogsId);
        continue;
      }

      const events = await mbClient.getReleaseEventsByReleaseGroupMbid(mbid);
      const withCountry = events.filter((e) => e.countryCode !== null);
      const withoutCountry = events.length - withCountry.length;

      if (withoutCountry > 0) {
        log.info(
          `[mb-release-events] Master ${masterDiscogsId}: ${withoutCountry} event(s) dropped (no country code)`,
        );
      }

      log.info(
        `[mb-release-events] Master ${masterDiscogsId}: ${withCountry.length} events to write`,
      );

      await mergeMbReleaseEvents(driver, masterDiscogsId, events);
      await setMbReleaseEventsFetched(driver, masterDiscogsId);

      eventsWritten += withCountry.length;
      mastersProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[mb-release-events] Failed for master ${masterDiscogsId}: ${msg}`);
      mastersFailed++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[mb-release-events] Enrichment complete: processed=${mastersProcessed}, skipped=${mastersSkipped}, failed=${mastersFailed}, eventsWritten=${eventsWritten}, duration=${durationMs}ms`,
  );

  return { mastersProcessed, mastersSkipped, mastersFailed, eventsWritten, durationMs };
}
