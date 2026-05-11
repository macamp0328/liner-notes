import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { aggregateArtistGenres, aggregateArtistStyles } from '../db/artist-genres-repository.js';

export interface ArtistGenresEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Aggregate genre and style data from Release nodes onto each Artist node.
 * Sets a.genres and a.styles as String[] properties derived from the Artist's
 * releases via IN_GENRE and IN_STYLE relationships.
 * Pure graph computation — no external API calls.
 */
export async function enrichArtistGenres(
  driver: Driver,
  logger?: Logger,
): Promise<ArtistGenresEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let failed = 0;

  log.info('[artist-genres] Starting genre/style aggregation onto Artist nodes');

  try {
    const genresUpdated = await aggregateArtistGenres(driver);
    const stylesUpdated = await aggregateArtistStyles(driver);
    enriched = Math.max(genresUpdated, stylesUpdated);
    log.info(
      `[artist-genres] Updated ${genresUpdated} artists with genres, ${stylesUpdated} with styles`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[artist-genres] Aggregation failed: ${msg}`);
    failed = 1;
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[artist-genres] Enrichment complete: enriched=${enriched}, skipped=0, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped: 0, failed, durationMs };
}
