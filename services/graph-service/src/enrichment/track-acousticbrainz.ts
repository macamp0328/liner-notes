import type { Driver } from 'neo4j-driver';
import type {
  AcousticBrainzClient,
  AcousticBrainzFeatures,
} from '../ingestion/acousticbrainz-client.js';
import { MAX_RECORDING_IDS_PER_CALL } from '../ingestion/acousticbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getTracksForAcousticBrainzEnrichment,
  setTrackAcousticBrainzFeatures,
} from '../db/track-acousticbrainz-repository.js';
import type { TrackAcousticBrainzResult } from '../db/track-acousticbrainz-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface TrackAcousticBrainzEnrichmentSummary {
  /** Tracks that received at least one non-null feature. */
  tracksProcessed: number;
  /** Tracks queried successfully but for which AcousticBrainz had no data. */
  tracksSkipped: number;
  /** Tracks in a batch whose AcousticBrainz fetch or write failed (left unmarked, will retry). */
  tracksFailed: number;
  durationMs: number;
}

const EMPTY_FEATURES: AcousticBrainzFeatures = {
  tempo: null,
  musicalKey: null,
  musicalScale: null,
  loudnessDb: null,
  dynamicComplexity: null,
  danceabilityEstimate: null,
  voiceInstrumental: null,
};

function hasAnyFeature(features: AcousticBrainzFeatures): boolean {
  return Object.values(features).some((value) => value !== null);
}

/**
 * Enrich Track nodes with AcousticBrainz audio features (tempo, key, loudness, etc.).
 *
 * Reads every Track that carries a `recordingMbid` (set by the track-musicbrainz
 * enrichment) but still has no features, deduplicates by MBID — the same recording can
 * appear on multiple releases — and fetches features in bulk batches. A track with no
 * features is retried at most once per staleness window (see getTracksForAcousticBrainzEnrichment).
 *
 * Every track in a successfully-processed batch is stamped `acousticBrainzFetchedAt`
 * even when AcousticBrainz had no data, throttling its retries. A batch whose fetch or
 * write throws leaves its tracks unstamped, so a later run retries them immediately.
 */
export async function enrichTrackAcousticBrainz(
  abClient: AcousticBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<TrackAcousticBrainzEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let tracksProcessed = 0;
  let tracksSkipped = 0;
  let tracksFailed = 0;

  log.info('[track-acousticbrainz] Starting AcousticBrainz audio feature enrichment');

  let tracks;
  try {
    tracks = await getTracksForAcousticBrainzEnrichment(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[track-acousticbrainz] Failed to fetch tracks for enrichment: ${msg}`);
    return {
      tracksProcessed: 0,
      tracksSkipped: 0,
      tracksFailed: 1,
      durationMs: Date.now() - startTime,
    };
  }

  // Deduplicate by recording MBID — one AcousticBrainz lookup can fan out to many tracks.
  const elementIdsByMbid = new Map<string, string[]>();
  for (const track of tracks) {
    const existing = elementIdsByMbid.get(track.recordingMbid);
    if (existing === undefined) {
      elementIdsByMbid.set(track.recordingMbid, [track.elementId]);
    } else {
      existing.push(track.elementId);
    }
  }

  const uniqueMbids = [...elementIdsByMbid.keys()];
  const total = uniqueMbids.length;
  log.info(
    `[track-acousticbrainz] Found ${tracks.length} unenriched tracks across ${total} unique recordings`,
  );
  onProgress(0, total);

  const batchCount = Math.ceil(total / MAX_RECORDING_IDS_PER_CALL);
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const batch = uniqueMbids.slice(
      batchIndex * MAX_RECORDING_IDS_PER_CALL,
      (batchIndex + 1) * MAX_RECORDING_IDS_PER_CALL,
    );

    if (batchIndex > 0 && batchIndex % 10 === 0) {
      log.info(
        `[track-acousticbrainz] Progress: batch ${batchIndex}/${batchCount} — processed=${tracksProcessed}, skipped=${tracksSkipped}, failed=${tracksFailed}`,
      );
    }

    try {
      const featuresByMbid = await abClient.getFeatures(batch);

      const results: TrackAcousticBrainzResult[] = [];
      let batchProcessed = 0;
      let batchSkipped = 0;
      for (const mbid of batch) {
        const features = featuresByMbid.get(mbid) ?? EMPTY_FEATURES;
        const matched = hasAnyFeature(features);
        for (const elementId of elementIdsByMbid.get(mbid) ?? []) {
          results.push({ elementId, ...features });
          if (matched) {
            batchProcessed++;
          } else {
            batchSkipped++;
          }
        }
      }

      await setTrackAcousticBrainzFeatures(driver, results);

      // Count only after a successful write — failed writes leave tracks unmarked.
      tracksProcessed += batchProcessed;
      tracksSkipped += batchSkipped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[track-acousticbrainz] Failed for batch ${batchIndex + 1}/${batchCount}: ${msg}`);
      for (const mbid of batch) {
        tracksFailed += (elementIdsByMbid.get(mbid) ?? []).length;
      }
    }

    // Report in recording (MBID) units — the unit of actual work after dedup.
    onProgress(Math.min((batchIndex + 1) * MAX_RECORDING_IDS_PER_CALL, total), total);
  }

  onProgress(total, total);
  const durationMs = Date.now() - startTime;
  log.info(
    `[track-acousticbrainz] Enrichment complete: processed=${tracksProcessed}, skipped=${tracksSkipped}, failed=${tracksFailed}, duration=${durationMs}ms`,
  );

  return { tracksProcessed, tracksSkipped, tracksFailed, durationMs };
}
