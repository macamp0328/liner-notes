import type { Driver } from 'neo4j-driver';
import { DiscogsClient } from './discogs-client.js';
import { mergeReleaseGraph } from '../db/ingestion-repository.js';

export interface IngestionConfig {
  username: string;
  delayMs: number;
}

export interface IngestionSummary {
  releasesProcessed: number;
  releasesFailed: number;
  errors: string[];
  durationMs: number;
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
  const startTime = Date.now();
  const errors: string[] = [];
  let releasesProcessed = 0;
  let releasesFailed = 0;

  console.info(`[ingest] Starting ingestion for user: ${config.username}`);

  // Step 1: Collect all release IDs from the paginated collection endpoint
  const releaseIds: number[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    console.info(`[ingest] Fetching collection page ${page}/${totalPages}`);
    const collectionPage = await client.getCollectionReleases(config.username, page, PER_PAGE);
    totalPages = collectionPage.pagination.pages;

    for (const entry of collectionPage.releases) {
      releaseIds.push(entry.id);
    }

    page++;
  } while (page <= totalPages);

  const total = releaseIds.length;
  console.info(`[ingest] Found ${total} releases to process`);

  // Step 2: Fetch and MERGE each release
  for (const releaseId of releaseIds) {
    try {
      const release = await client.getRelease(releaseId);
      await mergeReleaseGraph(driver, release);
      releasesProcessed++;

      if (releasesProcessed % PROGRESS_INTERVAL === 0) {
        console.info(`[ingest] Progress: ${releasesProcessed}/${total} releases processed`);
      }
    } catch (err) {
      releasesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      const errorEntry = `Release ${releaseId}: ${msg}`;
      errors.push(errorEntry);
      console.error(`[ingest] Failed to process release ${releaseId}: ${msg}`);
    }
  }

  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;

  const summary: IngestionSummary = {
    releasesProcessed,
    releasesFailed,
    errors,
    durationMs,
  };

  console.info(
    `[ingest] Ingestion complete:\n` +
      `  Releases processed: ${releasesProcessed}\n` +
      `  Releases failed:    ${releasesFailed}\n` +
      `  Duration:           ${minutes}m ${seconds}s\n` +
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
export function buildDiscogsClientFromEnv(): DiscogsClient | null {
  const token = process.env['DISCOGS_TOKEN'];
  const userAgent = process.env['DISCOGS_USER_AGENT'] ?? 'liner-notes/1.0';
  const delayMs = parseInt(process.env['DISCOGS_REQUEST_DELAY_MS'] ?? '1000', 10);

  if (!token) {
    console.warn('[ingest] DISCOGS_TOKEN not set — skipping ingestion');
    return null;
  }

  return new DiscogsClient({ token, userAgent, delayMs });
}
