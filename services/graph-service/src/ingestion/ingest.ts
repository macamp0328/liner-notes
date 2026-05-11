import type { Driver } from 'neo4j-driver';
import { DiscogsClient } from './discogs-client.js';
import type { Logger } from './discogs-client.js';
import { mergeReleaseGraph } from '../db/ingestion-repository.js';
import { enrichLyrics } from '../enrichment/lyrics.js';
import type { LyricsEnrichmentSummary } from '../enrichment/lyrics.js';
import { enrichOriginalYear } from '../enrichment/original-year.js';
import type { OriginalYearEnrichmentSummary } from '../enrichment/original-year.js';
import { enrichArtistGenres } from '../enrichment/artist-genres.js';
import type { ArtistGenresEnrichmentSummary } from '../enrichment/artist-genres.js';
import { enrichTrackVersions } from '../enrichment/track-versions.js';
import type { TrackVersionsEnrichmentSummary } from '../enrichment/track-versions.js';
import { enrichArtistProfiles } from '../enrichment/artist-profiles.js';
import type { ArtistProfilesEnrichmentSummary } from '../enrichment/artist-profiles.js';

export type { Logger };
export type { LyricsEnrichmentSummary };
export type { OriginalYearEnrichmentSummary };
export type { ArtistGenresEnrichmentSummary };
export type { TrackVersionsEnrichmentSummary };
export type { ArtistProfilesEnrichmentSummary };

export interface IngestionConfig {
  username: string;
  /** Optional structured logger; defaults to console when omitted. Pass app.log in production. */
  logger?: Logger;
}

export interface IngestionSummary {
  releasesProcessed: number;
  releasesFailed: number;
  errors: string[];
  durationMs: number;
  lyricsEnrichment: LyricsEnrichmentSummary;
  originalYearEnrichment: OriginalYearEnrichmentSummary;
  artistGenresEnrichment: ArtistGenresEnrichmentSummary;
  trackVersionsEnrichment: TrackVersionsEnrichmentSummary;
  artistProfilesEnrichment: ArtistProfilesEnrichmentSummary;
}

const PER_PAGE = 50;
const PROGRESS_INTERVAL = 10;

/**
 * Run the full Discogs → Neo4j ingestion pipeline.
 *
 * Steps:
 *   1. Paginate GET /users/{username}/collection/folders/0/releases
 *   2. For each release: fetch full release, MERGE all entities into Neo4j
 *   3. Catch per-release errors (log + continue — one bad release must not abort the pipeline)
 *   4. Return an IngestionSummary
 *
 * The DiscogsClient handles rate limiting and 429 backoff internally.
 * Call this asynchronously from server.ts onReady — do not await it there.
 */
export async function runIngestion(
  client: DiscogsClient,
  driver: Driver,
  config: IngestionConfig,
): Promise<IngestionSummary> {
  const log: Logger = config.logger ?? console;
  const startTime = Date.now();
  const errors: string[] = [];
  let releasesProcessed = 0;
  let releasesFailed = 0;

  log.info(`[ingest] Starting ingestion for user: ${config.username}`);

  // Step 1: Collect all release IDs from the paginated collection endpoint
  const releaseIds: number[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    log.info(`[ingest] Fetching collection page ${page}/${totalPages}`);
    const collectionPage = await client.getCollectionReleases(config.username, page, PER_PAGE);
    totalPages = collectionPage.pagination.pages;

    for (const entry of collectionPage.releases) {
      releaseIds.push(entry.id);
    }

    page++;
  } while (page <= totalPages);

  const total = releaseIds.length;
  log.info(`[ingest] Found ${total} releases to process`);

  // Step 2: Fetch and MERGE each release
  for (const releaseId of releaseIds) {
    try {
      const release = await client.getRelease(releaseId);
      await mergeReleaseGraph(driver, release);
      releasesProcessed++;

      if (releasesProcessed % PROGRESS_INTERVAL === 0) {
        log.info(`[ingest] Progress: ${releasesProcessed}/${total} releases processed`);
      }
    } catch (err) {
      releasesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      const errorEntry = `Release ${releaseId}: ${msg}`;
      errors.push(errorEntry);
      log.error(`[ingest] Failed to process release ${releaseId}: ${msg}`);
    }
  }

  // Step 3: Enrich tracks with lyrics (LRCLIB primary, Genius fallback)
  const lyricsEnrichment = await enrichLyrics(driver, log);

  // Step 4: Enrich releases with originalYear from Discogs master API
  const originalYearEnrichment = await enrichOriginalYear(client, driver, log);

  // Step 5: Aggregate genres/styles from Release nodes onto Artist nodes
  const artistGenresEnrichment = await enrichArtistGenres(driver, log);

  // Step 6: Create IS_VERSION_OF relationships between track variants
  const trackVersionsEnrichment = await enrichTrackVersions(driver, log);

  // Step 7: Enrich Artist nodes with realName + profile from Discogs artist API
  const artistProfilesEnrichment = await enrichArtistProfiles(client, driver, log);

  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;

  const summary: IngestionSummary = {
    releasesProcessed,
    releasesFailed,
    errors,
    durationMs,
    lyricsEnrichment,
    originalYearEnrichment,
    artistGenresEnrichment,
    trackVersionsEnrichment,
    artistProfilesEnrichment,
  };

  log.info(
    `[ingest] Ingestion complete:\n` +
      `  Releases processed:   ${releasesProcessed}\n` +
      `  Releases failed:      ${releasesFailed}\n` +
      `  Lyrics enriched:      ${lyricsEnrichment.enriched}\n` +
      `  Lyrics skipped:       ${lyricsEnrichment.skipped}\n` +
      `  Lyrics failed:        ${lyricsEnrichment.failed}\n` +
      `  Original year enrich: ${originalYearEnrichment.enriched}\n` +
      `  Original year skip:   ${originalYearEnrichment.skipped}\n` +
      `  Original year failed: ${originalYearEnrichment.failed}\n` +
      `  Artist genres enrich: ${artistGenresEnrichment.enriched}\n` +
      `  Artist genres failed: ${artistGenresEnrichment.failed}\n` +
      `  Track versions enrich:${trackVersionsEnrichment.enriched}\n` +
      `  Track versions skip:  ${trackVersionsEnrichment.skipped}\n` +
      `  Track versions failed:${trackVersionsEnrichment.failed}\n` +
      `  Artist profiles enrich:${artistProfilesEnrichment.enriched}\n` +
      `  Artist profiles skip: ${artistProfilesEnrichment.skipped}\n` +
      `  Artist profiles failed:${artistProfilesEnrichment.failed}\n` +
      `  Duration:             ${minutes}m ${seconds}s\n` +
      (errors.length > 0
        ? `  Errors:\n${errors.map((e) => `    - ${e}`).join('\n')}`
        : `  Errors:             none`),
  );

  return summary;
}

/**
 * Build a DiscogsClient from environment variables.
 * Returns null and logs a warning if required vars are missing (graceful skip).
 */
const DEFAULT_DELAY_MS = 1_000;
const MIN_DELAY_MS = 100;

export function buildDiscogsClientFromEnv(logger?: Logger): DiscogsClient | null {
  const token = process.env['DISCOGS_TOKEN'];
  const userAgent = process.env['DISCOGS_USER_AGENT'] ?? 'liner-notes/1.0';

  if (!token) {
    // Return null silently — callers (e.g. server.ts onReady) log the skip via their own logger.
    return null;
  }

  // Validate and clamp delay: malformed/negative values fall back to the default.
  const parsed = parseInt(process.env['DISCOGS_REQUEST_DELAY_MS'] ?? '', 10);
  const delayMs = Number.isFinite(parsed) && parsed >= MIN_DELAY_MS ? parsed : DEFAULT_DELAY_MS;

  return new DiscogsClient({
    token,
    userAgent,
    delayMs,
    ...(logger !== undefined ? { logger } : {}),
  });
}
