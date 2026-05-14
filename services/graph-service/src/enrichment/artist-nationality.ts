import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { WikidataClient } from '../ingestion/wikidata-client.js';
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
 * Resolve nationality from MusicBrainz and Wikidata in parallel.
 *
 * Strategy:
 * - Fire both lookups concurrently (both index on Discogs ID, so identity is guaranteed).
 * - If both agree → use the result.
 * - If only one has data → use it.
 * - If they disagree → prefer Wikidata (more consistently accurate for country of citizenship)
 *   and log the discrepancy so it can be investigated.
 * - If neither has data → return null (skip).
 */
async function resolveCountry(
  mbClient: MusicBrainzClient,
  wdClient: WikidataClient | null,
  discogsId: number,
  label: string,
  log: Logger,
): Promise<string | null> {
  const [mbCountry, wdCountry] = await Promise.all([
    mbClient.getCountryByDiscogsId(discogsId),
    wdClient ? wdClient.getCountryByDiscogsId(discogsId) : Promise.resolve(null),
  ]);

  if (mbCountry !== null && wdCountry !== null && mbCountry !== wdCountry) {
    log.warn(
      `[artist-nationality] Source conflict for ${label} discogsId=${discogsId}: MB=${mbCountry} WD=${wdCountry} — using Wikidata`,
    );
    return wdCountry;
  }

  return mbCountry ?? wdCountry ?? null;
}

/**
 * Enrich Artist and Musician nodes with ORIGIN_COUNTRY relationships.
 * Sources: MusicBrainz (primary) + Wikidata (fallback and conflict resolution), queried in parallel.
 *
 * For Artist nodes: looks up by Discogs ID.
 * For Musician nodes: looks up by Discogs ID when available; falls back to MusicBrainz name search
 * for musicians without a Discogs ID (lower confidence — only used when score ≥ 90).
 *
 * Sets nationalityFetched = true on every processed node regardless of outcome.
 * Per-node errors are caught and counted — never crashes the caller.
 */
export async function enrichArtistNationality(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  wdClient?: WikidataClient,
): Promise<ArtistNationalityEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const wd = wdClient ?? null;
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
      const countryCode = await resolveCountry(mbClient, wd, artist.discogsId, 'Artist', log);
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
        countryCode = await resolveCountry(mbClient, wd, musician.discogsId, 'Musician', log);
      } else {
        // No Discogs ID — name search is MB-only (Wikidata requires an ID to avoid false matches)
        countryCode = await mbClient.getCountryByName(musician.name);
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
