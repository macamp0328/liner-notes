import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import { getUnenrichedArtists, setArtistProfile } from '../db/artist-profiles-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface ArtistProfilesEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Enrich Artist nodes with realName and profile from the Discogs artist API.
 * Fetches GET /artists/{discogsId} for each Artist that still has neither realName nor
 * profile and whose last attempt has aged past the staleness window (see
 * getUnenrichedArtists). setArtistProfile stamps profileFetchedAt on every attempt so a
 * still-empty artist is retried at most once per window rather than every run.
 * Rate limiting is handled by DiscogsClient internally.
 * Per-artist errors are caught and counted — never crashes the caller.
 *
 * Note: Discogs does not expose a structured nationality or originCity field.
 * The profile property (free-text biography) is stored as-is for future use.
 */
export async function enrichArtistProfiles(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<ArtistProfilesEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[artist-profiles] Starting artist profile enrichment');

  let artists;
  try {
    artists = await getUnenrichedArtists(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[artist-profiles] Failed to fetch unenriched artists: ${msg}`);
    return { enriched: 0, skipped: 0, failed: 1, durationMs: Date.now() - startTime };
  }

  const total = artists.length;
  log.info(`[artist-profiles] Found ${total} artists without profile`);
  onProgress(0, total);

  let i = 0;
  for (const artist of artists) {
    i++;
    if (i % 25 === 0) onProgress(i, total);
    try {
      const profile = await client.getArtist(artist.discogsId);

      const realName = profile.realname?.trim() || null;
      const profileText = profile.profile?.trim() || null;

      // Always call setArtistProfile — it stamps profileFetchedAt regardless of whether
      // profile data was present, throttling retries of still-empty artists.
      await setArtistProfile(driver, artist.discogsId, realName, profileText);

      if (realName === null && profileText === null) {
        skipped++;
      } else {
        enriched++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[artist-profiles] Failed for artist ${artist.discogsId}: ${msg}`);
      failed++;
    }
  }

  onProgress(total, total);
  const durationMs = Date.now() - startTime;
  log.info(
    `[artist-profiles] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
