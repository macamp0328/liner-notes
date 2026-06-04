import type { Driver } from 'neo4j-driver';
import type { DeezerClient } from '../ingestion/deezer-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import { getTracksForDeezerEnrichment, setTrackDeezerData } from '../db/track-deezer-repository.js';
import type { TrackDeezerResult } from '../db/track-deezer-repository.js';

export interface TrackDeezerEnrichmentSummary {
  /** Tracks that received a non-null bpm or gain. */
  tracksProcessed: number;
  /** Tracks queried successfully but for which Deezer had no data. */
  tracksSkipped: number;
  /** Tracks whose Deezer fetch or write failed (left unmarked, will retry). */
  tracksFailed: number;
  durationMs: number;
}

/** Accumulated results are flushed to Neo4j once this many tracks are pending. */
const WRITE_BATCH_SIZE = 50;

/**
 * Enrich Track nodes with BPM and loudness data from Deezer via ISRC lookup.
 *
 * Reads every Track that carries an `isrc` (set by the track-musicbrainz enrichment) but
 * still has no Deezer data, deduplicates by ISRC — the same recording can appear on
 * multiple releases — and looks each unique ISRC up once, fanning the result out to every
 * track that shares it. A track with no Deezer data is retried at most once per staleness
 * window (see getTracksForDeezerEnrichment).
 *
 * Results are flushed to Neo4j incrementally in batches of {@link WRITE_BATCH_SIZE}, so a
 * late failure only loses one batch. Every track in a successfully-written batch is stamped
 * `deezerFetchedAt` even when Deezer had no data, throttling its retries. A track whose
 * fetch or write fails is left unstamped, so a later run retries it immediately.
 */
export async function enrichTrackDeezer(
  deezerClient: DeezerClient,
  driver: Driver,
  logger?: Logger,
): Promise<TrackDeezerEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let tracksProcessed = 0;
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
      tracksSkipped: 0,
      tracksFailed: 1,
      durationMs: Date.now() - startTime,
    };
  }

  // Deduplicate by ISRC — one Deezer lookup can fan out to many tracks.
  const elementIdsByIsrc = new Map<string, string[]>();
  for (const track of tracks) {
    const existing = elementIdsByIsrc.get(track.isrc);
    if (existing === undefined) {
      elementIdsByIsrc.set(track.isrc, [track.elementId]);
    } else {
      existing.push(track.elementId);
    }
  }

  const uniqueIsrcs = [...elementIdsByIsrc.keys()];
  log.info(
    `[track-deezer] Found ${tracks.length} unenriched tracks across ${uniqueIsrcs.length} unique ISRCs`,
  );

  // Pending buffer — accumulated results not yet written. Counts are applied only after a
  // successful flush, so a failed write leaves the affected tracks uncounted and unmarked.
  let pendingResults: TrackDeezerResult[] = [];
  let pendingProcessed = 0;
  let pendingSkipped = 0;

  const flush = async (): Promise<void> => {
    if (pendingResults.length === 0) return;
    try {
      await setTrackDeezerData(driver, pendingResults);
      tracksProcessed += pendingProcessed;
      tracksSkipped += pendingSkipped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `[track-deezer] Failed to write a batch of ${pendingResults.length} tracks: ${msg}`,
      );
      tracksFailed += pendingResults.length;
    } finally {
      pendingResults = [];
      pendingProcessed = 0;
      pendingSkipped = 0;
    }
  };

  let i = 0;
  for (const isrc of uniqueIsrcs) {
    if (i > 0 && i % 50 === 0) {
      log.info(
        `[track-deezer] Progress: ${i}/${uniqueIsrcs.length} ISRCs — processed=${tracksProcessed}, skipped=${tracksSkipped}, failed=${tracksFailed}`,
      );
    }
    i++;

    const elementIds = elementIdsByIsrc.get(isrc) ?? [];

    let data;
    try {
      data = await deezerClient.getTrackByIsrc(isrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[track-deezer] Failed for ISRC ${isrc}: ${msg}`);
      tracksFailed += elementIds.length;
      continue;
    }

    const matched = data !== null && (data.bpm !== null || data.gain !== null);
    for (const elementId of elementIds) {
      pendingResults.push({
        elementId,
        deezerBpm: data?.bpm ?? null,
        deezerGain: data?.gain ?? null,
      });
      if (matched) {
        pendingProcessed++;
      } else {
        pendingSkipped++;
      }
    }

    if (pendingResults.length >= WRITE_BATCH_SIZE) {
      await flush();
    }
  }

  await flush();

  const durationMs = Date.now() - startTime;
  log.info(
    `[track-deezer] Enrichment complete: processed=${tracksProcessed}, skipped=${tracksSkipped}, failed=${tracksFailed}, duration=${durationMs}ms`,
  );

  return { tracksProcessed, tracksSkipped, tracksFailed, durationMs };
}
