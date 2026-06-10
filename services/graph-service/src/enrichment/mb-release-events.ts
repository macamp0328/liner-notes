import type { Driver } from 'neo4j-driver';
import type { MbReleaseEvent, MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getMastersForReleaseEventEnrichment,
  mergeMbReleaseEvents,
  setMbReleaseEventsFetched,
} from '../db/mb-release-events-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface MbReleaseEventsEnrichmentSummary {
  mastersProcessed: number;
  mastersSkipped: number;
  mastersFailed: number;
  eventsWritten: number;
  durationMs: number;
}

/** A candidate Master to look up in MusicBrainz. */
type MasterCandidate = { masterDiscogsId: number };

/** The events found for a linked Master, plus how many carry a usable country code. */
type ResolvedEvents = { events: MbReleaseEvent[]; withCountryCount: number };

/**
 * Enrich Master nodes with MB_RELEASED_IN relationships to Country nodes.
 *
 * For each unenriched Master, walks: Discogs master ID → MB release group MBID →
 * paginated official releases → release events. Writes one MB_RELEASED_IN relationship
 * per event that has an ISO-3166-1 country code, keyed on mbReleaseId for idempotency.
 *
 * Stamps mbReleaseEventsFetchedAt on every successfully processed Master, including those
 * with no MB link — so a master with no events is retried at most once per staleness window.
 * Failed masters are NOT stamped so they are retried on the next run.
 */
export async function enrichMbReleaseEvents(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<MbReleaseEventsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  let eventsWritten = 0;
  let candidateCount = 0;

  const stage: EnrichmentStage<MasterCandidate, ResolvedEvents> = {
    name: 'mb-release-events',
    async selectCandidates(d) {
      const masters = await getMastersForReleaseEventEnrichment(d);
      candidateCount = masters.length;
      return masters;
    },
    async resolve({ masterDiscogsId }) {
      const mbid = await mbClient.getReleaseGroupMbidByMasterDiscogsId(masterDiscogsId);

      if (mbid === null) {
        log.info(`[mb-release-events] No MB link for master ${masterDiscogsId} — skipping`);
        return null;
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

      return { events, withCountryCount: withCountry.length };
    },
    async write(d, { masterDiscogsId }, resolved) {
      await mergeMbReleaseEvents(d, masterDiscogsId, resolved.events);
      await setMbReleaseEventsFetched(d, masterDiscogsId);
      eventsWritten += resolved.withCountryCount;
    },
    markAttempted: (d, { masterDiscogsId }) => setMbReleaseEventsFetched(d, masterDiscogsId),
    describeItem: ({ masterDiscogsId }) => `master ${masterDiscogsId}`,
    progressEveryItems: 10,
  };

  const summary = await runEnrichment(driver, stage, { logger: log, onProgress });

  if (candidateCount > 0 && summary.failed === 0 && eventsWritten === 0) {
    log.warn(
      `[mb-release-events] No-op: ${candidateCount} master(s) found, 0 failures, but 0 events written (processed=${summary.enriched}, skipped=${summary.skipped}). Expected >0 — verify the MusicBrainz master→release-group lookup and that resolved release groups have country-coded release events, before treating this as complete.`,
    );
  }

  return {
    mastersProcessed: summary.enriched,
    mastersSkipped: summary.skipped,
    mastersFailed: summary.failed,
    eventsWritten,
    durationMs: summary.durationMs,
  };
}
