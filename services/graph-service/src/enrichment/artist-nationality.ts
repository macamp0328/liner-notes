import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { WikidataClient } from '../ingestion/wikidata-client.js';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import type { VIAFClient, ViafMetrics } from '../ingestion/viaf-client.js';
import { createEmptyViafMetrics } from '../ingestion/viaf-client.js';
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
 * Per-run instrumentation for #194: how many nationalities each source was credited with this
 * run (i.e. the source that was *selected* — MB when it answers and Wikidata agrees or is null,
 * Wikidata on disagreement / WD-only / Wikipedia-URL fallback), plus VIAF's HTTP-outcome tally.
 * Because sources are tried in priority order and VIAF is last (only after MB and Wikidata both
 * return null), `resolvedByViaf` *is* VIAF's unique contribution — the MB/WD counts are not
 * strictly "unique" because an agreement is credited to MB. `viafOk` ("got HTTP 200 + JSON") is
 * deliberately distinct from `resolvedByViaf` ("VIAF produced a country") — their gap, and the
 * size of `viafBotBlocked`/`viafHtml`, is the answers-but-no-match vs bot-blocked signal.
 */
export interface NationalityExtras {
  resolvedByMusicbrainz: number;
  resolvedByWikidata: number;
  resolvedByViaf: number;
  viafCalls: number;
  viafOk: number;
  viafBotBlocked: number;
  viafHtml: number;
  viafHttpError: number;
  viafRateLimited: number;
  viafNetworkError: number;
}

function zeroNationalityExtras(): NationalityExtras {
  return {
    resolvedByMusicbrainz: 0,
    resolvedByWikidata: 0,
    resolvedByViaf: 0,
    viafCalls: 0,
    viafOk: 0,
    viafBotBlocked: 0,
    viafHtml: 0,
    viafHttpError: 0,
    viafRateLimited: 0,
    viafNetworkError: 0,
  };
}

export interface NationalityEnrichmentSummary extends NationalityExtras {
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

    // Source 3: VIAF name search (last resort)
    if (viafClient !== null) {
      const country = await viafClient.getCountryByName(name);
      if (country !== null) return { country, source: 'viaf' };
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
): Promise<ResolvedNationality | null> {
  const mbCountry = await mbClient.getCountryByName(name);
  if (mbCountry !== null) return { country: mbCountry, source: 'musicbrainz' };
  if (viafClient !== null) {
    const viafCountry = await viafClient.getCountryByName(name);
    if (viafCountry !== null) return { country: viafCountry, source: 'viaf' };
  }
  return null;
}

/**
 * Enrich Artist and Musician nodes with ORIGIN_COUNTRY relationships.
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
  viafClient?: VIAFClient,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<NationalityEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const wd = wdClient ?? null;
  const dc = discogsClient ?? null;
  const viaf = viafClient ?? null;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  const bySource: Record<NationalitySource, number> = { musicbrainz: 0, wikidata: 0, viaf: 0 };
  // switch (not bySource[source]++) to keep eslint-plugin-security's object-injection rule happy.
  const recordSource = (source: NationalitySource): void => {
    switch (source) {
      case 'musicbrainz':
        bySource.musicbrainz++;
        break;
      case 'wikidata':
        bySource.wikidata++;
        break;
      case 'viaf':
        bySource.viaf++;
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
        viaf,
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
            viaf,
            person.discogsId,
            person.name,
            label.slice(0, -1), // "musicians" → "musician" for log label
            log,
          );
        } else {
          resolved = await resolveCountryByName(mbClient, viaf, person.name);
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

  // Single read: the VIAF client is built fresh per run (both the orchestrated reload's
  // buildReloadContext and the standalone /nationality/enrich route construct a new client),
  // so its lifetime tally is exactly this run's contribution — no before/after diff needed.
  const vm: ViafMetrics = viaf?.getMetrics() ?? createEmptyViafMetrics();

  log.info(
    `[artist-nationality] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );
  log.info(
    `[artist-nationality] Resolved by source: musicbrainz=${bySource.musicbrainz}, wikidata=${bySource.wikidata}, viaf=${bySource.viaf}`,
  );
  log.info(
    `[artist-nationality] VIAF outcomes: calls=${vm.calls}, ok=${vm.ok}, botBlocked=${vm.botBlocked}, html=${vm.html}, httpError=${vm.httpError}, rateLimited=${vm.rateLimited}, networkError=${vm.networkError}`,
  );

  return {
    enriched,
    skipped,
    failed,
    durationMs,
    resolvedByMusicbrainz: bySource.musicbrainz,
    resolvedByWikidata: bySource.wikidata,
    resolvedByViaf: bySource.viaf,
    viafCalls: vm.calls,
    viafOk: vm.ok,
    viafBotBlocked: vm.botBlocked,
    viafHtml: vm.html,
    viafHttpError: vm.httpError,
    viafRateLimited: vm.rateLimited,
    viafNetworkError: vm.networkError,
  };
}
