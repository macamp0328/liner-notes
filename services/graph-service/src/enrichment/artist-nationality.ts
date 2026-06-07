import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { WikidataClient } from '../ingestion/wikidata-client.js';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedArtistsForNationality,
  getUnenrichedMusiciansForNationality,
  setArtistNationality,
  setMusicianNationality,
} from '../db/artist-nationality-repository.js';
import type { UnenrichedMusician, NationalitySource } from '../db/artist-nationality-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

/** A resolved country plus the source that produced it, or null when unresolved. */
type ResolvedNationality = { country: string; source: NationalitySource };

/**
 * Per-run instrumentation: how many nationalities each source was credited with this run (i.e. the
 * source that was *selected* — MB when it answers and Wikidata agrees or is null, Wikidata on
 * disagreement / WD-only / Wikipedia-URL fallback). Neither count is strictly "unique" because an
 * MB/WD agreement is credited to MB.
 */
export interface NationalityExtras {
  resolvedByMusicbrainz: number;
  resolvedByWikidata: number;
}

function zeroNationalityExtras(): NationalityExtras {
  return {
    resolvedByMusicbrainz: 0,
    resolvedByWikidata: 0,
  };
}

export interface NationalityEnrichmentSummary extends NationalityExtras {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Resolve nationality using two sources in priority order:
 *
 * 1. MusicBrainz + Wikidata by Discogs ID (parallel, high confidence)
 * 2. Wikidata via Wikipedia URL from Discogs artist page (high confidence when URL present)
 *
 * Source 1 runs in parallel. Source 2 is a sequential fallback, only attempted when the
 * previous sources return null.
 *
 * Conflict resolution for source 1: when MB and WD disagree, Wikidata is preferred and
 * the discrepancy is logged.
 */
async function resolveCountry(
  mbClient: MusicBrainzClient,
  wdClient: WikidataClient | null,
  discogsClient: DiscogsClient | null,
  discogsId: number | null,
  name: string,
  label: string,
  log: Logger,
): Promise<ResolvedNationality | null> {
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
      return { country: wdCountry, source: 'wikidata' };
    }

    if (mbCountry !== null) return { country: mbCountry, source: 'musicbrainz' };
    if (wdCountry !== null) return { country: wdCountry, source: 'wikidata' };

    // Source 2: Wikidata via Wikipedia URL on the Discogs artist page
    if (discogsClient !== null && wdClient !== null) {
      try {
        const profile = await discogsClient.getArtist(discogsId);
        const wikipediaUrls = (profile.urls ?? []).filter((u) =>
          u.startsWith('https://en.wikipedia.org/wiki/'),
        );
        for (const url of wikipediaUrls) {
          const country = await wdClient.getCountryByWikipediaUrl(url);
          if (country !== null) return { country, source: 'wikidata' };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[artist-nationality] Wikipedia→WD lookup failed for ${label} "${name}" discogsId=${discogsId}: ${msg}`,
        );
      }
    }
  }

  return null;
}

/**
 * Resolve nationality for a person node that has no Discogs ID via MusicBrainz name search.
 * Wikidata is skipped — it requires an ID to avoid false matches.
 */
async function resolveCountryByName(
  mbClient: MusicBrainzClient,
  name: string,
): Promise<ResolvedNationality | null> {
  const mbCountry = await mbClient.getCountryByName(name);
  if (mbCountry !== null) return { country: mbCountry, source: 'musicbrainz' };
  return null;
}

/**
 * Enrich Artist and Musician nodes with ORIGIN_COUNTRY relationships.
 *
 * For nodes with a Discogs ID, sources are tried in order:
 * 1. MusicBrainz + Wikidata by Discogs ID (parallel)
 * 2. Wikidata via Wikipedia URL from Discogs artist page
 *
 * For nodes without a Discogs ID:
 * 1. MusicBrainz name search (score ≥ 90)
 *
 * Stamps nationalityFetchedAt on every node where a result (country code or null) is
 * successfully determined — so a node no source could resolve is retried at most once per
 * staleness window rather than every run. Nodes that throw an exception are counted as
 * failed and are NOT stamped, so the next enrichment run will retry them immediately.
 * Per-node errors are caught and never crash the caller.
 */
export async function enrichNationality(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  wdClient?: WikidataClient,
  discogsClient?: DiscogsClient,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<NationalityEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const wd = wdClient ?? null;
  const dc = discogsClient ?? null;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  const bySource: Record<NationalitySource, number> = { musicbrainz: 0, wikidata: 0 };
  // switch (not bySource[source]++) to keep eslint-plugin-security's object-injection rule happy.
  const recordSource = (source: NationalitySource): void => {
    switch (source) {
      case 'musicbrainz':
        bySource.musicbrainz++;
        break;
      case 'wikidata':
        bySource.wikidata++;
        break;
    }
  };

  log.info('[artist-nationality] Starting nationality enrichment');

  // Enrich Artist nodes
  let artists;
  try {
    artists = await getUnenrichedArtistsForNationality(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[artist-nationality] Failed to fetch unenriched artists: ${msg}`);
    return {
      enriched: 0,
      skipped: 0,
      failed: 1,
      durationMs: Date.now() - startTime,
      ...zeroNationalityExtras(),
    };
  }

  // `total` grows once per person group: the musician count isn't known until its fetch
  // runs below, so the denominator jumps up when the musician phase begins. `processed`
  // spans both loops so the bar advances continuously across the phase boundary.
  let total = artists.length;
  let processed = 0;
  log.info(`[artist-nationality] Found ${total} artists without nationality`);
  onProgress(processed, total);

  for (const artist of artists) {
    processed++;
    if (processed % 25 === 0) onProgress(processed, total);
    try {
      const resolved = await resolveCountry(
        mbClient,
        wd,
        dc,
        artist.discogsId,
        artist.name,
        'Artist',
        log,
      );
      await setArtistNationality(
        driver,
        artist.discogsId,
        resolved?.country ?? null,
        resolved?.source ?? null,
      );
      if (resolved !== null) {
        enriched++;
        recordSource(resolved.source);
      } else {
        skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[artist-nationality] Failed for artist ${artist.discogsId}: ${msg}`);
      failed++;
    }
  }

  // Enrich Musician nodes. Producers and engineers are Musician nodes too (the
  // role lives on CREDITED_ON, not the label), so this single scan covers them.
  const personGroups: Array<{
    label: string;
    fetch: () => Promise<UnenrichedMusician[]>;
    save: (
      driver: Driver,
      person: UnenrichedMusician,
      code: string | null,
      source: NationalitySource | null,
    ) => Promise<void>;
  }> = [
    {
      label: 'musicians',
      fetch: () => getUnenrichedMusiciansForNationality(driver),
      save: setMusicianNationality,
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

    total += people.length;
    log.info(`[artist-nationality] Found ${people.length} ${label} without nationality`);
    onProgress(processed, total);

    for (const person of people) {
      processed++;
      if (processed % 25 === 0) onProgress(processed, total);
      try {
        let resolved: ResolvedNationality | null = null;

        if (person.discogsId !== null) {
          resolved = await resolveCountry(
            mbClient,
            wd,
            dc,
            person.discogsId,
            person.name,
            label.slice(0, -1), // "musicians" → "musician" for log label
            log,
          );
        } else {
          resolved = await resolveCountryByName(mbClient, person.name);
        }

        await save(driver, person, resolved?.country ?? null, resolved?.source ?? null);

        if (resolved !== null) {
          enriched++;
          recordSource(resolved.source);
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

  onProgress(processed, total);
  const durationMs = Date.now() - startTime;

  log.info(
    `[artist-nationality] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );
  log.info(
    `[artist-nationality] Resolved by source: musicbrainz=${bySource.musicbrainz}, wikidata=${bySource.wikidata}`,
  );

  return {
    enriched,
    skipped,
    failed,
    durationMs,
    resolvedByMusicbrainz: bySource.musicbrainz,
    resolvedByWikidata: bySource.wikidata,
  };
}
