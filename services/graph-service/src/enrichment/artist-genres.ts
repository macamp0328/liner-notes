import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { aggregateArtistGenres, aggregateArtistStyles } from '../db/artist-genres-repository.js';

export interface ArtistGenresEnrichmentSummary {
  genresEnriched: number;
  stylesEnriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Aggregate genre and style data from Release nodes onto each Artist node.
 * Sets a.genres and a.styles as String[] properties derived from the Artist's
 * releases via IN_GENRE and IN_STYLE relationships.
 * Pure graph computation — no external API calls.
 *
 * Deliberately NOT a runEnrichment stage (#222): there is no candidate loop, no external
 * resolve, and no per-node `*FetchedAt` stamping — just two whole-graph Cypher aggregations
 * that recompute every Artist from scratch each run.
 */
export async function enrichArtistGenres(
  driver: Driver,
  logger?: Logger,
): Promise<ArtistGenresEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let genresEnriched = 0;
  let stylesEnriched = 0;
  let failed = 0;

  log.info('[artist-genres] Starting genre/style aggregation onto Artist nodes');

  try {
    genresEnriched = await aggregateArtistGenres(driver);
    stylesEnriched = await aggregateArtistStyles(driver);
    log.info(
      `[artist-genres] Updated ${genresEnriched} artists with genres, ${stylesEnriched} with styles`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[artist-genres] Aggregation failed: ${msg}`);
    failed = 1;
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[artist-genres] Enrichment complete: genresEnriched=${genresEnriched}, stylesEnriched=${stylesEnriched}, skipped=0, failed=${failed}, duration=${durationMs}ms`,
  );

  return { genresEnriched, stylesEnriched, skipped: 0, failed, durationMs };
}
