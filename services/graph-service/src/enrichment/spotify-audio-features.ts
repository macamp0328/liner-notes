import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import type { SpotifyClient } from '../ingestion/spotify-client.js';
import {
  getTracksForSpotifyEnrichment,
  setTrackAudioFeatures,
} from '../db/spotify-audio-repository.js';

export interface SpotifyAudioFeaturesEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

const BATCH_SIZE = 100;
// Duration within ±2s → high confidence; within ±5s → medium confidence
const HIGH_CONFIDENCE_TOLERANCE_S = 2;
const MEDIUM_CONFIDENCE_TOLERANCE_S = 5;

/**
 * Enrich Track nodes with Spotify audio features.
 *
 * Match strategy:
 *   1. Search Spotify by artist + title (top 5 candidates)
 *   2. Pick the candidate whose duration is closest to t.durationSeconds
 *   3. Accept if within ±5s; mark "high" if within ±2s, "medium" otherwise
 *   4. Collect matched spotifyIds, batch-fetch audio features (≤100 per call)
 *   5. SET all 13 audio properties on the Track node
 *
 * Idempotent: only processes tracks where spotifyId IS NULL.
 * Never crashes the caller — per-track errors are caught, logged, and counted.
 */
export async function enrichSpotifyAudioFeatures(
  client: SpotifyClient,
  driver: Driver,
  logger?: Logger,
): Promise<SpotifyAudioFeaturesEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[spotify] Starting Spotify audio features enrichment');

  const tracks = await getTracksForSpotifyEnrichment(driver);
  log.info(`[spotify] Found ${tracks.length} tracks eligible for Spotify enrichment`);

  // Phase 1: search for each track and collect matches
  type MatchedTrack = {
    releaseDiscogsId: number;
    position: string;
    spotifyId: string;
    confidence: 'high' | 'medium';
  };

  const matched: MatchedTrack[] = [];

  for (const track of tracks) {
    try {
      const candidates = await client.searchTrack(track.artistName ?? '', track.title);

      let bestId: string | null = null;
      let bestDiff = Infinity;

      for (const candidate of candidates) {
        const diffS = Math.abs(candidate.durationMs / 1000 - track.durationSeconds);
        if (diffS < bestDiff) {
          bestDiff = diffS;
          bestId = candidate.id;
        }
      }

      if (bestId === null || bestDiff > MEDIUM_CONFIDENCE_TOLERANCE_S) {
        skipped++;
        continue;
      }

      const confidence: 'high' | 'medium' =
        bestDiff <= HIGH_CONFIDENCE_TOLERANCE_S ? 'high' : 'medium';

      matched.push({
        releaseDiscogsId: track.releaseDiscogsId,
        position: track.position,
        spotifyId: bestId,
        confidence,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[spotify] Search failed for "${track.title}": ${msg}`);
      failed++;
    }
  }

  log.info(`[spotify] Matched ${matched.length} tracks; fetching audio features in batches`);

  // Phase 2: batch-fetch audio features and write to Neo4j
  for (let i = 0; i < matched.length; i += BATCH_SIZE) {
    const batch = matched.slice(i, i + BATCH_SIZE);
    const ids = batch.map((m) => m.spotifyId);

    let featuresMap: Awaited<ReturnType<typeof client.getAudioFeaturesBatch>>;
    try {
      featuresMap = await client.getAudioFeaturesBatch(ids);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[spotify] Audio features batch failed (ids ${i}–${i + batch.length - 1}): ${msg}`);
      failed += batch.length;
      continue;
    }

    for (const matchedTrack of batch) {
      const features = featuresMap.get(matchedTrack.spotifyId);
      if (!features) {
        // Spotify returned null for this id (no audio analysis available)
        skipped++;
        continue;
      }

      try {
        await setTrackAudioFeatures(driver, matchedTrack.releaseDiscogsId, matchedTrack.position, {
          ...features,
          spotifyMatchConfidence: matchedTrack.confidence,
        });
        enriched++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `[spotify] Failed to store features for track at position ${matchedTrack.position} (release ${matchedTrack.releaseDiscogsId}): ${msg}`,
        );
        failed++;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[spotify] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
