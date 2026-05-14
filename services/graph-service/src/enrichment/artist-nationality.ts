import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedArtistsForNationality,
  getUnenrichedMusiciansForNationality,
  setArtistNationality,
  setMusicianNationality,
} from '../db/artist-nationality-repository.js';

export interface ArtistNationalityEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Enrich Artist and Musician nodes with ORIGIN_COUNTRY relationships sourced from MusicBrainz.
 *
 * For Artist nodes: looks up by Discogs ID (two-step MusicBrainz URL → artist lookup).
 * For Musician nodes: looks up by Discogs ID when available; falls back to name search
 * for musicians without a Discogs ID (lower confidence — only used when score ≥ 90).
 *
 * Sets nationalityFetched = true on every processed node regardless of whether a country
 * was found — same idempotency pattern as profileFetched on artist profiles.
 * Per-node errors are caught and counted — never crashes the caller.
 */
export async function enrichArtistNationality(
  client: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
): Promise<ArtistNationalityEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[artist-nationality] Starting nationality enrichment');

  // Enrich Artist nodes
  let artists;
  try {
    artists = await getUnenrichedArtistsForNationality(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[artist-nationality] Failed to fetch unenriched artists: ${msg}`);
    return { enriched: 0, skipped: 0, failed: 1, durationMs: Date.now() - startTime };
  }

  log.info(`[artist-nationality] Found ${artists.length} artists without nationality`);

  for (const artist of artists) {
    try {
      const countryCode = await client.getCountryByDiscogsId(artist.discogsId);
      await setArtistNationality(driver, artist.discogsId, countryCode);
      if (countryCode !== null) {
        enriched++;
      } else {
        skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[artist-nationality] Failed for artist ${artist.discogsId}: ${msg}`);
      failed++;
    }
  }

  // Enrich Musician nodes
  let musicians;
  try {
    musicians = await getUnenrichedMusiciansForNationality(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[artist-nationality] Failed to fetch unenriched musicians: ${msg}`);
    const durationMs = Date.now() - startTime;
    log.info(
      `[artist-nationality] Partial complete (artists done, musicians failed): enriched=${enriched}, skipped=${skipped}, failed=${failed + 1}, duration=${durationMs}ms`,
    );
    return { enriched, skipped, failed: failed + 1, durationMs };
  }

  log.info(`[artist-nationality] Found ${musicians.length} musicians without nationality`);

  for (const musician of musicians) {
    try {
      let countryCode: string | null = null;

      if (musician.discogsId !== null) {
        countryCode = await client.getCountryByDiscogsId(musician.discogsId);
      } else {
        countryCode = await client.getCountryByName(musician.name);
      }

      await setMusicianNationality(driver, musician, countryCode);

      if (countryCode !== null) {
        enriched++;
      } else {
        skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `[artist-nationality] Failed for musician "${musician.name}" (discogsId=${musician.discogsId ?? 'none'}): ${msg}`,
      );
      failed++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[artist-nationality] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
