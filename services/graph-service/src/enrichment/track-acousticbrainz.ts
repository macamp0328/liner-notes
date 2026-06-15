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
  markTrackAcousticBrainzExhausted,
} from '../db/track-acousticbrainz-repository.js';
import type { TrackAcousticBrainzResult } from '../db/track-acousticbrainz-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import { getShutdownSignal } from '../lifecycle/shutdown.js';

export interface TrackAcousticBrainzEnrichmentSummary {
  /** Tracks that received at least one non-null feature. */
  tracksProcessed: number;
  /**
   * Always 0 for this frozen source — there is no throttled-recheck path: a recording with no
   * usable features is terminal, not retried. Retained for summary-shape parity with the
   * throttled track-deezer summary (issue #384).
   */
  tracksSkipped: number;
  /**
   * Tracks AcousticBrainz had no usable features for, marked permanently exhausted (issue #384).
   * AcousticBrainz is frozen/read-only, so a confirmed absence never gains data — never re-queried.
   */
  tracksExhausted: number;
  /** Tracks in a batch whose AcousticBrainz fetch or write failed (left unmarked, will retry). */
  tracksFailed: number;
  durationMs: number;
}

function hasAnyFeature(features: AcousticBrainzFeatures): boolean {
  return Object.values(features).some((value) => value !== null);
}

/**
 * Enrich Track nodes with AcousticBrainz audio features (tempo, key, loudness, etc.).
 *
 * Reads every Track that carries a `recordingMbid` (set by the track-musicbrainz
 * enrichment) but still has no features, deduplicates by MBID — the same recording can
 * appear on multiple releases — and fetches features in bulk batches.
 *
 * AcousticBrainz is frozen/read-only (#371/#377), so a recording with no usable features in a
 * SUCCESSFUL bulk response will never gain any — it is **terminal**, not throttled. Such a track
 * is marked permanently `acousticBrainzExhausted` (counted `exhausted`) and never re-queried
 * (issue #384, the batch-local analog of the runner's TERMINAL_EMPTY / ADR 0003). A track that
 * DOES get ≥1 feature is written + stamped (`processed`). Only a transient failure — a fetch or
 * write throwing (retry-exhausted 5xx, timeout, open breaker) — leaves a batch's tracks unmarked
 * so a later run retries them immediately (`failed`). There is therefore no `skipped` outcome.
 *
 * Deliberately NOT a runEnrichment stage (#222): the unit of work is a bulk batch of up to
 * {@link MAX_RECORDING_IDS_PER_CALL} deduplicated MBIDs per API call — resolve, write, and
 * failure accounting are all batch-scoped (a failed batch fails every fanned-out track),
 * which the per-item EnrichmentStage contract cannot express without giving up the bulk
 * fetch.
 */
export async function enrichTrackAcousticBrainz(
  abClient: AcousticBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
  signal: AbortSignal = getShutdownSignal(),
): Promise<TrackAcousticBrainzEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let tracksProcessed = 0;
  const tracksSkipped = 0;
  let tracksExhausted = 0;
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
      tracksExhausted: 0,
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
  // Hoisted out of the for-header so the post-loop tail can report how many batches actually ran.
  let batchIndex = 0;
  for (; batchIndex < batchCount; batchIndex++) {
    // Checkpoint-and-exit on SIGTERM (#291): each batch is a self-contained fetch+write, so breaking
    // between batches leaves a consistent partial run; unwritten MBIDs stay unstamped and resume.
    if (signal.aborted) break;
    const batch = uniqueMbids.slice(
      batchIndex * MAX_RECORDING_IDS_PER_CALL,
      (batchIndex + 1) * MAX_RECORDING_IDS_PER_CALL,
    );

    if (batchIndex > 0 && batchIndex % 10 === 0) {
      log.info(
        `[track-acousticbrainz] Progress: batch ${batchIndex}/${batchCount} — processed=${tracksProcessed}, exhausted=${tracksExhausted}, failed=${tracksFailed}`,
      );
    }

    try {
      const featuresByMbid = await abClient.getFeatures(batch);

      // getFeatures resolved, so absence is genuine & permanent (frozen source). A recording with
      // ≥1 usable feature is written; one with none (absent from the map, or present-but-all-null)
      // is terminal — marked exhausted so it never re-qualifies as a candidate (#384).
      const featureResults: TrackAcousticBrainzResult[] = [];
      const exhaustedElementIds: string[] = [];
      let batchProcessed = 0;
      let batchExhausted = 0;
      for (const mbid of batch) {
        const features = featuresByMbid.get(mbid);
        const elementIds = elementIdsByMbid.get(mbid) ?? [];
        if (features !== undefined && hasAnyFeature(features)) {
          for (const elementId of elementIds) {
            featureResults.push({ elementId, ...features });
            batchProcessed++;
          }
        } else {
          for (const elementId of elementIds) {
            exhaustedElementIds.push(elementId);
            batchExhausted++;
          }
        }
      }

      // Features first (the valuable, non-derivable data), then the terminal marker — so a
      // mid-batch crash persists features before the re-derivable marker. Both are idempotent
      // SETs keyed on elementId.
      await setTrackAcousticBrainzFeatures(driver, featureResults);
      await markTrackAcousticBrainzExhausted(driver, exhaustedElementIds);

      // Count only after BOTH writes succeed — a throw on either leaves the whole batch counted
      // failed (catch below), never double-counted.
      tracksProcessed += batchProcessed;
      tracksExhausted += batchExhausted;
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

  const durationMs = Date.now() - startTime;
  if (signal.aborted) {
    // Report the REAL recording count, not total — an aborted run must not read as 100% (#291).
    const attempted = Math.min(batchIndex * MAX_RECORDING_IDS_PER_CALL, total);
    onProgress(attempted, total);
    log.info(
      `[track-acousticbrainz] Aborted at batch ${batchIndex}/${batchCount} (${attempted}/${total} recordings) — processed=${tracksProcessed}, exhausted=${tracksExhausted}, failed=${tracksFailed}, duration=${durationMs}ms`,
    );
  } else {
    onProgress(total, total);
    log.info(
      `[track-acousticbrainz] Enrichment complete: processed=${tracksProcessed}, exhausted=${tracksExhausted}, failed=${tracksFailed}, duration=${durationMs}ms`,
    );
  }

  return { tracksProcessed, tracksSkipped, tracksExhausted, tracksFailed, durationMs };
}
