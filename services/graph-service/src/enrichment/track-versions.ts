import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { deriveVersionType } from '../ingestion/transforms.js';
import {
  getVersionCandidates,
  mergeVersionRelationships,
  releasesShareArtist,
} from '../db/track-versions-repository.js';
import type { VersionPair } from '../db/track-versions-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

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
 *   2. For each group, find every release pair that shares an artist (full
 *      pairwise check). The validated cluster is the set of releases that
 *      appear in at least one overlapping pair. Skip groups with no overlap.
 *   3. Within the validated cluster, pick the track from the release with the
 *      lowest discogsId as the "root" and link all other cluster tracks to it.
 *      Tracks from releases outside the cluster are excluded — they may be
 *      coincidental title matches from unrelated artists.
 *   4. Derive versionType from each variant's original title.
 *
 * Pure graph computation — no external API calls.
 */
export async function enrichTrackVersions(
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<TrackVersionsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[track-versions] Starting IS_VERSION_OF enrichment');

  try {
    const groups = await getVersionCandidates(driver);
    const total = groups.length;
    log.info(`[track-versions] Found ${total} candidate version groups`);
    onProgress(0, total);

    let i = 0;
    for (const group of groups) {
      i++;
      if (i % 25 === 0) onProgress(i, total);
      try {
        // Collect unique release IDs in this group
        const releaseIds = [...new Set(group.tracks.map((t) => t.releaseDiscogsId))];

        if (releaseIds.length < 2) {
          skipped++;
          continue;
        }

        // Build the validated cluster: all releases that participate in at
        // least one artist-overlap pair. Full pairwise check ensures we don't
        // miss pairs where the first release is unrelated to the others.
        const validatedReleaseIds = new Set<number>();
        for (let i = 0; i < releaseIds.length - 1; i++) {
          for (let j = i + 1; j < releaseIds.length; j++) {
            // eslint-disable-next-line security/detect-object-injection
            const idI = releaseIds[i]!;
            // eslint-disable-next-line security/detect-object-injection
            const idJ = releaseIds[j]!;
            if (await releasesShareArtist(driver, idI, idJ)) {
              validatedReleaseIds.add(idI);
              validatedReleaseIds.add(idJ);
            }
          }
        }
        if (validatedReleaseIds.size === 0) {
          skipped++;
          continue;
        }

        // Filter to validated cluster only; root = lowest releaseDiscogsId.
        const sorted = group.tracks
          .filter((t) => validatedReleaseIds.has(t.releaseDiscogsId))
          .sort((a, b) => a.releaseDiscogsId - b.releaseDiscogsId);
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
    onProgress(total, total);
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
