import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { WikidataClient } from '../ingestion/wikidata-client.js';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import type { VIAFClient } from '../ingestion/viaf-client.js';
import {
  getUnenrichedArtistsForNationality,
  getUnenrichedMusiciansForNationality,
  getUnenrichedProducersForNationality,
  getUnenrichedEngineersForNationality,
  setArtistNationality,
  setMusicianNationality,
  setProducerNationality,
  setEngineerNationality,
} from '../db/artist-nationality-repository.js';
import type { UnenrichedMusician } from '../db/artist-nationality-repository.js';

export interface NationalityEnrichmentSummary {
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
        `[artist-nationality] Source conflict for ${label} "${name}" discogsId=${discogsId}: MB=${mbCountry} WD=${wdCountry} — using Wikidata`,
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
          `[artist-nationality] Wikipedia→WD lookup failed for ${label} "${name}" discogsId=${discogsId}: ${msg}`,
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
 * Resolve nationality for a person node that has no Discogs ID.
 * Tries MusicBrainz name search first, then VIAF name search as a fallback.
 * Wikidata is skipped — it requires an ID to avoid false matches.
 */
async function resolveCountryByName(
  mbClient: MusicBrainzClient,
  viafClient: VIAFClient | null,
  name: string,
): Promise<string | null> {
  const mbCountry = await mbClient.getCountryByName(name);
  if (mbCountry !== null) return mbCountry;
  if (viafClient !== null) return viafClient.getCountryByName(name);
  return null;
}

/**
 * Enrich Artist, Musician, Producer, and Engineer nodes with ORIGIN_COUNTRY relationships.
 *
 * For nodes with a Discogs ID, sources are tried in order:
 * 1. MusicBrainz + Wikidata by Discogs ID (parallel)
 * 2. Wikidata via Wikipedia URL from Discogs artist page
 * 3. VIAF name search
 *
 * For nodes without a Discogs ID:
 * 1. MusicBrainz name search (score ≥ 90)
 * 2. VIAF name search
 *
 * Sets nationalityFetched = true on every node where a result (country code or null)
 * is successfully determined. Nodes that throw an exception are counted as failed and
 * are NOT marked as fetched, so the next enrichment run will retry them.
 * Per-node errors are caught and never crash the caller.
 */
export async function enrichNationality(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  wdClient?: WikidataClient,
  discogsClient?: DiscogsClient,
  viafClient?: VIAFClient,
): Promise<NationalityEnrichmentSummary> {
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

  // Enrich Musician, Producer, and Engineer nodes with identical logic
  const personGroups: Array<{
    label: string;
    fetch: () => Promise<UnenrichedMusician[]>;
    save: (driver: Driver, person: UnenrichedMusician, code: string | null) => Promise<void>;
  }> = [
    {
      label: 'musicians',
      fetch: () => getUnenrichedMusiciansForNationality(driver),
      save: setMusicianNationality,
    },
    {
      label: 'producers',
      fetch: () => getUnenrichedProducersForNationality(driver),
      save: setProducerNationality,
    },
    {
      label: 'engineers',
      fetch: () => getUnenrichedEngineersForNationality(driver),
      save: setEngineerNationality,
    },
  ];

  for (const { label, fetch, save } of personGroups) {
    let people;
    try {
      people = await fetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[artist-nationality] Failed to fetch unenriched ${label}: ${msg}`);
      failed++;
      continue;
    }

    log.info(`[artist-nationality] Found ${people.length} ${label} without nationality`);

    for (const person of people) {
      try {
        let countryCode: string | null = null;

        if (person.discogsId !== null) {
          countryCode = await resolveCountry(
            mbClient,
            wd,
            dc,
            viaf,
            person.discogsId,
            person.name,
            label.slice(0, -1), // "musicians" → "musician" for log label
            log,
          );
        } else {
          countryCode = await resolveCountryByName(mbClient, viaf, person.name);
        }

        await save(driver, person, countryCode);

        if (countryCode !== null) {
          enriched++;
        } else {
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          `[artist-nationality] Failed for ${label.slice(0, -1)} "${person.name}" (discogsId=${person.discogsId ?? 'none'}): ${msg}`,
        );
        failed++;
      }
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[artist-nationality] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
