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
import type {
  UnenrichedArtist,
  UnenrichedMusician,
  NationalitySource,
} from '../db/artist-nationality-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
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
 * Runs as two sequential runEnrichment stages — Artists, then Musicians (producers and
 * engineers are Musician nodes too; the role lives on CREDITED_ON, not the label, so the
 * single Musician scan covers them). Stamps nationalityFetchedAt on every node where a
 * result (country code or null) is successfully determined — so a node no source could
 * resolve is retried at most once per staleness window rather than every run. Nodes that
 * throw an exception are counted as failed and are NOT stamped, so the next enrichment run
 * will retry them immediately. Per-node errors are caught and never crash the caller; a
 * failure fetching one group's candidates no longer prevents the other group from running.
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

  // The musician count isn't known until the artist phase finishes, so the reported
  // denominator grows when the musician stage begins: the artist stage reports (i, artists)
  // and the musician stage reports (artists + i, artists + musicians).
  let artistTotal = 0;

  const artistStage: EnrichmentStage<UnenrichedArtist, ResolvedNationality> = {
    name: 'artist-nationality',
    async selectCandidates(d) {
      const artists = await getUnenrichedArtistsForNationality(d);
      artistTotal = artists.length;
      return artists;
    },
    resolve: (artist) =>
      resolveCountry(mbClient, wd, dc, artist.discogsId, artist.name, 'Artist', log),
    async write(d, artist, resolved) {
      await setArtistNationality(d, artist.discogsId, resolved.country, resolved.source);
      recordSource(resolved.source);
    },
    markAttempted: (d, artist) => setArtistNationality(d, artist.discogsId, null, null),
    describeItem: (artist) => `artist ${artist.discogsId}`,
  };

  const artistSummary = await runEnrichment(driver, artistStage, {
    logger: log,
    // Swallow the artist stage's final 100% report — the musician stage immediately
    // re-reports against the grown denominator, avoiding a momentary 100% blip.
    onProgress: (i, total) => {
      if (total > 0 && i === total) return;
      onProgress(i, total);
    },
  });

  const musicianStage: EnrichmentStage<UnenrichedMusician, ResolvedNationality> = {
    name: 'artist-nationality',
    selectCandidates: (d) => getUnenrichedMusiciansForNationality(d),
    resolve: (person) =>
      person.discogsId !== null
        ? resolveCountry(mbClient, wd, dc, person.discogsId, person.name, 'musician', log)
        : resolveCountryByName(mbClient, person.name),
    async write(d, person, resolved) {
      await setMusicianNationality(d, person, resolved.country, resolved.source);
      recordSource(resolved.source);
    },
    markAttempted: (d, person) => setMusicianNationality(d, person, null, null),
    describeItem: (person) => `musician "${person.name}" (discogsId=${person.discogsId ?? 'none'})`,
  };

  const musicianSummary = await runEnrichment(driver, musicianStage, {
    logger: log,
    onProgress: (i, total) => onProgress(artistTotal + i, artistTotal + total),
  });

  const durationMs = Date.now() - startTime;

  log.info(
    `[artist-nationality] Resolved by source: musicbrainz=${bySource.musicbrainz}, wikidata=${bySource.wikidata}`,
  );

  return {
    enriched: artistSummary.enriched + musicianSummary.enriched,
    skipped: artistSummary.skipped + musicianSummary.skipped,
    failed: artistSummary.failed + musicianSummary.failed,
    durationMs,
    resolvedByMusicbrainz: bySource.musicbrainz,
    resolvedByWikidata: bySource.wikidata,
  };
}
