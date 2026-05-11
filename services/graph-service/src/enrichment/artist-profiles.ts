import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import { getUnenrichedArtists, setArtistProfile } from '../db/artist-profiles-repository.js';

export interface ArtistProfilesEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Enrich Artist nodes with realName and profile from the Discogs artist API.
 * Fetches GET /artists/{discogsId} for each Artist without a profile property.
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
): Promise<ArtistProfilesEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[artist-profiles] Starting artist profile enrichment');

  const artists = await getUnenrichedArtists(driver);
  log.info(`[artist-profiles] Found ${artists.length} artists without profile`);

  for (const artist of artists) {
    try {
      const profile = await client.getArtist(artist.discogsId);

      const realName = profile.realname?.trim() || null;
      const profileText = profile.profile?.trim() || null;

      if (realName === null && profileText === null) {
        // Store explicit nulls so the node is not re-fetched on subsequent runs.
        await setArtistProfile(driver, artist.discogsId, null, null);
        skipped++;
        continue;
      }

      await setArtistProfile(driver, artist.discogsId, realName, profileText);
      enriched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[artist-profiles] Failed for artist ${artist.discogsId}: ${msg}`);
      failed++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[artist-profiles] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
