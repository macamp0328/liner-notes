import type { Driver } from 'neo4j-driver';
import { DiscogsClient } from './discogs-client.js';
import type { Logger } from './discogs-client.js';
import { mergeReleaseGraph } from '../db/ingestion-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from '../enrichment/progress.js';
import { enrichLyrics } from '../enrichment/lyrics.js';
import type { LyricsEnrichmentSummary } from '../enrichment/lyrics.js';
import { enrichMasterData } from '../enrichment/master-data.js';
import type { MasterDataEnrichmentSummary } from '../enrichment/master-data.js';
import { enrichArtistGenres } from '../enrichment/artist-genres.js';
import type { ArtistGenresEnrichmentSummary } from '../enrichment/artist-genres.js';
import { enrichArtistProfiles } from '../enrichment/artist-profiles.js';
import type { ArtistProfilesEnrichmentSummary } from '../enrichment/artist-profiles.js';

export type { Logger };
export type { LyricsEnrichmentSummary };
export type { MasterDataEnrichmentSummary };
export type { ArtistGenresEnrichmentSummary };
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
  masterDataEnrichment: MasterDataEnrichmentSummary;
  artistGenresEnrichment: ArtistGenresEnrichmentSummary;
  artistProfilesEnrichment: ArtistProfilesEnrichmentSummary;
}

const PER_PAGE = 50;
const PROGRESS_INTERVAL = 10;

/**
 * Run a single enrichment stage with failure isolation.
 *
 * Enrichment stages are independent and individually idempotent (each selects
 * the nodes it still needs to process). A throw escaping one stage — a transient
 * Neo4j write error, or an upstream 5xx that slips past the stage's own per-item
 * catch — must not abort the stages that follow it. The error is logged and
 * pushed onto `errors` so it surfaces in the run summary and, via the level>=50
 * log line, in CloudWatch. The stage's `fallback` summary is returned so the
 * pipeline can continue and report zero progress for the skipped stage.
 */
async function runStage<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
  log: Logger,
  errors: string[],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Enrichment stage "${name}": ${msg}`);
    log.error(`[ingest] Enrichment stage "${name}" failed and was skipped: ${msg}`);
    return fallback;
  }
}

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
export interface ReleasesIngestSummary {
  releasesProcessed: number;
  releasesFailed: number;
  errors: string[];
}

/**
 * Fetch the user's full Discogs collection and MERGE every release into Neo4j.
 *
 * Extracted from runIngestion (issue #175) so the orchestrated reload's `releases` stage
 * and the legacy /ingest path share one definition. Per-release failures are caught,
 * logged, and collected — one bad release must not abort the rest. Every write is a MERGE,
 * so a re-run is idempotent: already-loaded releases are no-ops and an interrupted run
 * resumes safely (the reload's `releases` stage re-fetches the whole collection on resume).
 */
export async function ingestReleases(
  client: DiscogsClient,
  driver: Driver,
  username: string,
  log: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<ReleasesIngestSummary> {
  const errors: string[] = [];
  let releasesProcessed = 0;
  let releasesFailed = 0;

  // Step 1: Collect all release IDs from the paginated collection endpoint
  const releaseIds: number[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    log.info(`[ingest] Fetching collection page ${page}/${totalPages}`);
    const collectionPage = await client.getCollectionReleases(username, page, PER_PAGE);
    totalPages = collectionPage.pagination.pages;

    for (const entry of collectionPage.releases) {
      releaseIds.push(entry.id);
    }

    page++;
  } while (page <= totalPages);

  const total = releaseIds.length;
  log.info(`[ingest] Found ${total} releases to process`);
  onProgress(0, total);

  // Step 2: Fetch and MERGE each release
  for (const releaseId of releaseIds) {
    try {
      const release = await client.getRelease(releaseId);
      await mergeReleaseGraph(driver, release);
      releasesProcessed++;

      if (releasesProcessed % PROGRESS_INTERVAL === 0) {
        log.info(`[ingest] Progress: ${releasesProcessed}/${total} releases processed`);
        onProgress(releasesProcessed, total);
      }
    } catch (err) {
      releasesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Release ${releaseId}: ${msg}`);
      log.error(`[ingest] Failed to process release ${releaseId}: ${msg}`);
    }
  }

  onProgress(total, total);
  return { releasesProcessed, releasesFailed, errors };
}

export async function runIngestion(
  client: DiscogsClient,
  driver: Driver,
  config: IngestionConfig,
): Promise<IngestionSummary> {
  const log: Logger = config.logger ?? console;
  const startTime = Date.now();

  // Don't interpolate config.username (sourced from the DISCOGS_USERNAME env var) into the
  // log — CodeQL flags env-derived values in log messages as clear-text logging, and the
  // repo treats the username as personal data (CLAUDE.md "no hardcoded usernames").
  log.info('[ingest] Starting ingestion');

  // Steps 1-2: fetch the collection and MERGE each release (shared with the reload's
  // `releases` stage via ingestReleases — issue #175).
  const releasesSummary = await ingestReleases(client, driver, config.username, log);
  const { releasesProcessed, releasesFailed } = releasesSummary;
  const errors: string[] = [...releasesSummary.errors];

  // Steps 3-7: Enrichment stages. Each runs in isolation via runStage — a throw
  // in one stage is logged and recorded in `errors` but must NOT abort the stages
  // that follow. Before this, a transient failure in an early stage (e.g. lyrics)
  // silently skipped every later stage for the whole run, leaving master-data and
  // artist-profiles permanently null (issue #151).

  // Step 3: Enrich tracks with lyrics (LRCLIB primary, Genius fallback)
  const lyricsEnrichment = await runStage(
    'lyrics',
    () => enrichLyrics(driver, log),
    { enriched: 0, skipped: 0, failed: 0, durationMs: 0 },
    log,
    errors,
  );

  // Step 4: Enrich releases with master data (originalYear + global pressing countries/formats)
  const masterDataEnrichment = await runStage(
    'master-data',
    () => enrichMasterData(client, driver, log),
    { enriched: 0, skipped: 0, failed: 0, durationMs: 0 },
    log,
    errors,
  );

  // Step 5: Aggregate genres/styles from Release nodes onto Artist nodes
  const artistGenresEnrichment = await runStage(
    'artist-genres',
    () => enrichArtistGenres(driver, log),
    { genresEnriched: 0, stylesEnriched: 0, skipped: 0, failed: 0, durationMs: 0 },
    log,
    errors,
  );

  // Step 6: Enrich Artist nodes with realName + profile from Discogs artist API
  const artistProfilesEnrichment = await runStage(
    'artist-profiles',
    () => enrichArtistProfiles(client, driver, log),
    { enriched: 0, skipped: 0, failed: 0, durationMs: 0 },
    log,
    errors,
  );

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
    masterDataEnrichment,
    artistGenresEnrichment,
    artistProfilesEnrichment,
  };

  log.info(
    `[ingest] Ingestion complete:\n` +
      `  Releases processed:   ${releasesProcessed}\n` +
      `  Releases failed:      ${releasesFailed}\n` +
      `  Lyrics enriched:      ${lyricsEnrichment.enriched}\n` +
      `  Lyrics skipped:       ${lyricsEnrichment.skipped}\n` +
      `  Lyrics failed:        ${lyricsEnrichment.failed}\n` +
      `  Master data enrich:   ${masterDataEnrichment.enriched}\n` +
      `  Master data skip:     ${masterDataEnrichment.skipped}\n` +
      `  Master data failed:   ${masterDataEnrichment.failed}\n` +
      `  Artist genres (genres): ${artistGenresEnrichment.genresEnriched}\n` +
      `  Artist genres (styles): ${artistGenresEnrichment.stylesEnriched}\n` +
      `  Artist genres failed:  ${artistGenresEnrichment.failed}\n` +
      `  Artist profiles enrich: ${artistProfilesEnrichment.enriched}\n` +
      `  Artist profiles skip:  ${artistProfilesEnrichment.skipped}\n` +
      `  Artist profiles failed: ${artistProfilesEnrichment.failed}\n` +
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
