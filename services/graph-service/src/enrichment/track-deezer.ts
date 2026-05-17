import type { Driver } from 'neo4j-driver';
import type { DeezerClient } from '../ingestion/deezer-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import { getTracksForDeezerEnrichment, setTrackDeezerData } from '../db/track-deezer-repository.js';
import type { TrackDeezerResult } from '../db/track-deezer-repository.js';

export interface TrackDeezerEnrichmentSummary {
  tracksProcessed: number;
  tracksEnriched: number;
  tracksSkipped: number;
  tracksFailed: number;
  durationMs: number;
}

/**
 * Enrich Track nodes with BPM and loudness data from Deezer via ISRC lookup.
 *
 * For each Track that has an ISRC and has not yet been Deezer-enriched:
 *   1. Call GET /track/isrc:{ISRC} on the Deezer API
 *   2. Store deezerBpm and deezerGain (null when Deezer returns 0 or no data)
 *   3. Mark deezerFetched = true (idempotency guard)
 *
 * Failed tracks (API errors) are NOT marked fetched — they will be retried on
 * the next pipeline run. Tracks with no Deezer data are marked fetched and
 * counted as skipped.
 */
export async function enrichTrackDeezer(
  deezerClient: DeezerClient,
  driver: Driver,
  logger?: Logger,
): Promise<TrackDeezerEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let tracksProcessed = 0;
  let tracksEnriched = 0;
  let tracksSkipped = 0;
  let tracksFailed = 0;

  log.info('[track-deezer] Starting Deezer BPM/loudness enrichment');

  let tracks;
  try {
    tracks = await getTracksForDeezerEnrichment(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[track-deezer] Failed to fetch tracks for enrichment: ${msg}`);
    return {
      tracksProcessed: 0,
      tracksEnriched: 0,
      tracksSkipped: 0,
      tracksFailed: 1,
      durationMs: Date.now() - startTime,
    };
  }

  log.info(`[track-deezer] Found ${tracks.length} tracks with ISRCs to enrich`);

  const results: TrackDeezerResult[] = [];

  let i = 0;
  for (const track of tracks) {
    if (i > 0 && i % 50 === 0) {
      log.info(
        `[track-deezer] Progress: ${i}/${tracks.length} — enriched=${tracksEnriched}, skipped=${tracksSkipped}, failed=${tracksFailed}`,
      );
    }
    i++;

    try {
      const data = await deezerClient.getTrackByIsrc(track.isrc);
      tracksProcessed++;

      if (data !== null && (data.bpm !== null || data.gain !== null)) {
        results.push({ elementId: track.elementId, deezerBpm: data.bpm, deezerGain: data.gain });
        tracksEnriched++;
      } else {
        results.push({ elementId: track.elementId, deezerBpm: null, deezerGain: null });
        tracksSkipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[track-deezer] Failed for ISRC ${track.isrc}: ${msg}`);
      tracksFailed++;
    }
  }

  // Failed tracks are not in results — they are not marked fetched and will retry next run
  if (results.length > 0) {
    try {
      await setTrackDeezerData(driver, results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[track-deezer] Failed to write enrichment results: ${msg}`);
      // Write failed — no deezerFetched markers were set; report counts accurately
      tracksFailed += results.length;
      tracksEnriched = 0;
      tracksSkipped = 0;
      tracksProcessed = 0;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[track-deezer] Enrichment complete: processed=${tracksProcessed}, enriched=${tracksEnriched}, skipped=${tracksSkipped}, failed=${tracksFailed}, duration=${durationMs}ms`,
  );

  return { tracksProcessed, tracksEnriched, tracksSkipped, tracksFailed, durationMs };
}
