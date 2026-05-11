import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { deriveVersionType } from '../ingestion/transforms.js';
import {
  getVersionCandidates,
  mergeVersionRelationships,
  releasesShareArtist,
} from '../db/track-versions-repository.js';
import type { VersionPair } from '../db/track-versions-repository.js';

export interface TrackVersionsEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Create IS_VERSION_OF relationships between Track variants.
 *
 * Algorithm:
 *   1. Fetch all groups of tracks sharing a normalizedTitle across releases.
 *   2. For each group, verify artist overlap between releases (skip groups with
 *      no shared artist — coincidental title matches across unrelated artists).
 *   3. Within each validated group, pick the track from the release with the
 *      lowest discogsId as the "root" and link all other tracks to it.
 *   4. Derive versionType from each variant's original title.
 *
 * Pure graph computation — no external API calls.
 */
export async function enrichTrackVersions(
  driver: Driver,
  logger?: Logger,
): Promise<TrackVersionsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[track-versions] Starting IS_VERSION_OF enrichment');

  try {
    const groups = await getVersionCandidates(driver);
    log.info(`[track-versions] Found ${groups.length} candidate version groups`);

    for (const group of groups) {
      try {
        // Collect unique release IDs in this group
        const releaseIds = [...new Set(group.tracks.map((t) => t.releaseDiscogsId))];

        if (releaseIds.length < 2) {
          skipped++;
          continue;
        }

        // Verify that at least one pair of releases shares an artist.
        // Check the first two distinct releases as a proxy — if they share an
        // artist the group is credible; a full pairwise check is too expensive.
        const [idA, idB] = releaseIds as [number, number];
        const hasOverlap = await releasesShareArtist(driver, idA, idB);
        if (!hasOverlap) {
          skipped++;
          continue;
        }

        // Sort tracks by releaseDiscogsId ascending — lowest id is treated as root.
        const sorted = [...group.tracks].sort((a, b) => a.releaseDiscogsId - b.releaseDiscogsId);
        const root = sorted[0]!;
        const variants = sorted.slice(1);

        const pairs: VersionPair[] = variants.map((variant) => ({
          fromElementId: variant.elementId,
          toElementId: root.elementId,
          versionType: deriveVersionType(variant.title),
        }));

        await mergeVersionRelationships(driver, pairs);
        enriched += pairs.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[track-versions] Failed for normalizedTitle "${group.normalizedTitle}": ${msg}`);
        failed++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[track-versions] Failed to fetch version candidates: ${msg}`);
    failed++;
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[track-versions] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
