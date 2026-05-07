import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { getUnenrichedTracks, setTrackLyrics } from '../db/lyrics-repository.js';

export interface LyricsEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

interface LrclibResponse {
  plainLyrics?: string | null;
}

interface GeniusSearchResponse {
  response: {
    hits: Array<{
      type: string;
      result: { url: string };
    }>;
  };
}

/**
 * Fetch lyrics from LRCLIB.
 * Returns plainLyrics on 200, null on 404, throws on unexpected errors.
 */
async function fetchLrclib(artistName: string, title: string): Promise<string | null> {
  const url = new URL('https://lrclib.net/api/get');
  url.searchParams.set('track_name', title);
  url.searchParams.set('artist_name', artistName);

  const response = await fetch(url.toString());

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`);

  const data = (await response.json()) as LrclibResponse;
  return data.plainLyrics ?? null;
}

/**
 * Extract plain text from Genius HTML lyrics containers.
 * Targets <div data-lyrics-container> elements — strips all inner HTML tags.
 */
function extractLyricsFromHtml(html: string): string | null {
  const containerPattern = /<div[^>]+data-lyrics-container[^>]*>([\s\S]*?)<\/div>/g;
  const parts: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = containerPattern.exec(html)) !== null) {
    const inner = match[1];
    if (inner === undefined) continue;
    const text = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) parts.push(text);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Fetch lyrics from Genius: search API to find the song page, then scrape HTML.
 * Returns lyrics text or null if not found. Throws on network/API errors.
 */
async function fetchGenius(
  token: string,
  artistName: string,
  title: string,
): Promise<string | null> {
  const searchUrl = new URL('https://api.genius.com/search');
  searchUrl.searchParams.set('q', `${artistName} ${title}`);

  const searchResponse = await fetch(searchUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!searchResponse.ok) throw new Error(`Genius search returned ${searchResponse.status}`);

  const searchData = (await searchResponse.json()) as GeniusSearchResponse;
  const firstHit = searchData.response.hits[0];
  if (!firstHit) return null;

  const pageResponse = await fetch(firstHit.result.url);
  if (!pageResponse.ok) throw new Error(`Genius page returned ${pageResponse.status}`);

  const html = await pageResponse.text();
  return extractLyricsFromHtml(html);
}

/**
 * Enrich all Track nodes that lack lyrics.
 * Queries LRCLIB first; falls back to Genius when GENIUS_TOKEN is set.
 * Missing lyrics are logged and skipped — never crashes the caller.
 */
export async function enrichLyrics(
  driver: Driver,
  logger?: Logger,
): Promise<LyricsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[lyrics] Starting lyrics enrichment');

  const tracks = await getUnenrichedTracks(driver);
  log.info(`[lyrics] Found ${tracks.length} tracks without lyrics`);

  const geniusToken = process.env['GENIUS_TOKEN'];

  for (const track of tracks) {
    let lrclibResult: string | null = null;
    let lrclibFailed = false;

    try {
      lrclibResult = await fetchLrclib(track.artistName ?? '', track.title);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[lyrics] LRCLIB failed for "${track.title}": ${msg}`);
      failed++;
      lrclibFailed = true;
    }

    if (lrclibFailed) continue;

    if (lrclibResult !== null) {
      await setTrackLyrics(driver, track.releaseDiscogsId, track.position, lrclibResult, 'lrclib');
      enriched++;
      continue;
    }

    // LRCLIB returned null (404) — try Genius fallback
    if (geniusToken) {
      try {
        const geniusResult = await fetchGenius(geniusToken, track.artistName ?? '', track.title);
        if (geniusResult !== null) {
          await setTrackLyrics(
            driver,
            track.releaseDiscogsId,
            track.position,
            geniusResult,
            'genius',
          );
          enriched++;
        } else {
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[lyrics] Genius failed for "${track.title}": ${msg}`);
        failed++;
      }
    } else {
      log.debug?.('[lyrics] GENIUS_TOKEN not set — skipping Genius fallback');
      skipped++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[lyrics] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
