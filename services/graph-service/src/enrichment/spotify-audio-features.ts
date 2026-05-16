import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import type { SpotifyClient } from '../ingestion/spotify-client.js';
import {
  getTracksForSpotifyEnrichment,
  setTrackSpotifyId,
} from '../db/spotify-audio-repository.js';

export interface SpotifyEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

const HIGH_CONFIDENCE_TOLERANCE_S = 2;
const MEDIUM_CONFIDENCE_TOLERANCE_S = 5;

/**
 * Link Track nodes to Spotify by searching for each track by artist + title,
 * confirming via duration proximity (±5s), and storing spotifyId +
 * spotifyMatchConfidence on the Track node.
 *
 * Idempotent: only processes tracks where spotifyId IS NULL.
 * Never crashes the caller — per-track errors are caught, logged, and counted.
 */
export async function enrichSpotifyIds(
  client: SpotifyClient,
  driver: Driver,
  logger?: Logger,
): Promise<SpotifyEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[spotify] Starting Spotify ID enrichment');

  const tracks = await getTracksForSpotifyEnrichment(driver);
  log.info(`[spotify] Found ${tracks.length} tracks eligible for Spotify enrichment`);

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

      try {
        await setTrackSpotifyId(driver, track.releaseDiscogsId, track.position, bestId, confidence);
        enriched++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `[spotify] Failed to store spotifyId for track at position ${track.position} (release ${track.releaseDiscogsId}): ${msg}`,
        );
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[spotify] Search failed for "${track.title}": ${msg}`);
      failed++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[spotify] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
