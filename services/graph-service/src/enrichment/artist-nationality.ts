import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { WikidataClient } from '../ingestion/wikidata-client.js';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import type { VIAFClient } from '../ingestion/viaf-client.js';
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
 * Resolve nationality using three sources in priority order:
 *
 * 1. MusicBrainz + Wikidata by Discogs ID (parallel, high confidence)
 * 2. Wikidata via Wikipedia URL from Discogs artist page (high confidence when URL present)
 * 3. VIAF name search (last resort, lower confidence — requires a real name, not just an ID)
 *
 * Source 1 runs in parallel. Sources 2 and 3 are sequential fallbacks, only attempted
 * when the previous sources return null.
 *
 * Conflict resolution for source 1: when MB and WD disagree, Wikidata is preferred and
 * the discrepancy is logged.
 */
async function resolveCountry(
  mbClient: MusicBrainzClient,
  wdClient: WikidataClient | null,
  discogsClient: DiscogsClient | null,
  viafClient: VIAFClient | null,
  discogsId: number | null,
  name: string,
  label: string,
  log: Logger,
): Promise<string | null> {
  if (discogsId !== null) {
    // Source 1: MB + WD by Discogs ID (parallel)
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

    const source1Result = mbCountry ?? wdCountry ?? null;
    if (source1Result !== null) return source1Result;

    // Source 2: Wikidata via Wikipedia URL on the Discogs artist page
    if (discogsClient !== null && wdClient !== null) {
      try {
        const profile = await discogsClient.getArtist(discogsId);
        const wikipediaUrls = (profile.urls ?? []).filter((u) =>
          u.startsWith('https://en.wikipedia.org/wiki/'),
        );
        for (const url of wikipediaUrls) {
          const country = await wdClient.getCountryByWikipediaUrl(url);
          if (country !== null) return country;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[artist-nationality] Wikipedia→WD lookup failed for ${label} discogsId=${discogsId}: ${msg}`,
        );
      }
    }

    // Source 3: VIAF name search (last resort)
    if (viafClient !== null) {
      return viafClient.getCountryByName(name);
    }
  }

  return null;
}

/**
 * Enrich Artist and Musician nodes with ORIGIN_COUNTRY relationships.
 *
 * Sources tried in order (see resolveCountry for details):
 * 1. MusicBrainz + Wikidata by Discogs ID (parallel)
 * 2. Wikidata via Wikipedia URL from Discogs artist page
 * 3. VIAF name search (uses artist.name, so never queries with a bare numeric ID)
 *
 * For musicians without a Discogs ID, MusicBrainz name search is used instead
 * (lower confidence — only accepted when score ≥ 90). Sources 2 and 3 are skipped
 * for these musicians.
 *
 * Sets nationalityFetched = true on every processed node regardless of outcome.
 * Per-node errors are caught and counted — never crashes the caller.
 */
export async function enrichArtistNationality(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  wdClient?: WikidataClient,
  discogsClient?: DiscogsClient,
  viafClient?: VIAFClient,
): Promise<ArtistNationalityEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const wd = wdClient ?? null;
  const dc = discogsClient ?? null;
  const viaf = viafClient ?? null;
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
      const countryCode = await resolveCountry(
        mbClient,
        wd,
        dc,
        viaf,
        artist.discogsId,
        artist.name,
        'Artist',
        log,
      );
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
        countryCode = await resolveCountry(
          mbClient,
          wd,
          dc,
          viaf,
          musician.discogsId,
          musician.name,
          'Musician',
          log,
        );
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
