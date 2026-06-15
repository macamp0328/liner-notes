import type { Driver } from 'neo4j-driver';
import type { DiscogsClient, Logger } from '../ingestion/discogs-client.js';
import type { ArtistWikidataData, WikidataClient } from '../ingestion/wikidata-client.js';
import {
  getUnenrichedArtistsForWikidata,
  setArtistWikidata,
  type UnenrichedArtist,
} from '../db/artist-wikidata-repository.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export type ArtistWikidataEnrichmentSummary = EnrichmentSummary;

/**
 * Resolve an artist's Wikidata bundle, P1953 (Discogs ID) first then a Wikipedia-URL fallback.
 * The primary lookup soft-skips to null internally (never throws), so it can't fail the item; the
 * fallback's Discogs fetch CAN throw transiently, but — mirroring artist-nationality — we swallow
 * it to null (a throttled re-attempt next window) rather than letting one rate-limited profile
 * fetch mark the whole item `failed`. Returns the bundle, or null when neither source resolves it.
 */
async function resolveArtistData(
  wdClient: WikidataClient,
  discogsClient: DiscogsClient | undefined,
  discogsId: number,
  log: Logger,
): Promise<ArtistWikidataData | null> {
  const direct = await wdClient.getArtistDataByDiscogsId(discogsId);
  if (direct !== null) return direct;

  // Fallback: the Discogs profile may link an English Wikipedia article whose Wikidata item we can
  // resolve via schema:about, even when P1953 isn't set on Wikidata.
  if (discogsClient === undefined) return null;
  try {
    const profile = await discogsClient.getArtist(discogsId);
    const wikipediaUrls = (profile.urls ?? []).filter((u) =>
      u.startsWith('https://en.wikipedia.org/wiki/'),
    );
    for (const url of wikipediaUrls) {
      const viaWikipedia = await wdClient.getArtistDataByWikipediaUrl(url);
      if (viaWikipedia !== null) return viaWikipedia;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[artist-wikidata] Wikipedia→WD fallback failed for artist ${discogsId}: ${msg}`);
  }
  return null;
}

/**
 * Enrich Artist nodes with Wikidata biographical data (#341): resolve each artist's Wikidata QID
 * (joined on P1953, with a Wikipedia-URL fallback) and harvest lifespan (P569/P570), image (P18),
 * and awards (P166) as node properties. Throttle-only — an artist absent from Wikidata today may
 * appear later, so `resolve` returns null (→ `markAttempted` stamps `wikidataFetchedAt`) rather
 * than a terminal marker. Per-artist errors are isolated and counted by the runner.
 *
 * `discogsClient` is optional: the primary P1953 join needs no Discogs call (it uses the discogsId
 * already on the node), so the stage still runs without Discogs — only the Wikipedia-URL fallback
 * is skipped.
 */
export async function enrichArtistWikidata(
  wdClient: WikidataClient,
  discogsClient: DiscogsClient | undefined,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<ArtistWikidataEnrichmentSummary> {
  const log: Logger = logger ?? console;

  const stage: EnrichmentStage<UnenrichedArtist, ArtistWikidataData> = {
    name: 'artist-wikidata',
    selectCandidates: (d) => getUnenrichedArtistsForWikidata(d),
    resolve: (artist) => resolveArtistData(wdClient, discogsClient, artist.discogsId, log),
    write: (d, artist, resolved) => setArtistWikidata(d, artist.discogsId, resolved),
    // Stamps wikidataFetchedAt with no QID written, throttling retries of artists not in Wikidata.
    markAttempted: (d, artist) => setArtistWikidata(d, artist.discogsId, null),
    describeItem: (artist) => `artist ${artist.discogsId}`,
    progressEveryItems: 10,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
