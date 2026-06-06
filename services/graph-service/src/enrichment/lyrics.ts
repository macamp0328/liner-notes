import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { getUnenrichedTracks, setTrackLyrics, markLyricsFetched } from '../db/lyrics-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

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
      result: {
        id: number;
        url: string;
        primary_artist: { name: string };
      };
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

// The named HTML entities we decode in song lyrics, mapped to their characters.
// A Map (looked up with .get) rather than a plain object so a regex-derived key
// can't reach Object.prototype members (security/detect-object-injection).
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['mdash', '—'],
  ['ndash', '–'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
]);

// Decodes the most common HTML entities found in song lyrics.
//
// Single-pass decode: each match is consumed once and its replacement is never
// re-scanned, so a decoded character can't combine with neighbouring text to form
// a new entity that gets decoded again. The previous chained `.replace()` calls
// decoded numeric entities first, so input like `&#38;lt;` became `&lt;` and then
// `<` — a double-unescape that could reintroduce markup (CodeQL js/double-escaping).
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string): string => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      // Guard the Unicode range — String.fromCodePoint throws on out-of-range values.
      if (codePoint >= 0 && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
      return match;
    }
    return NAMED_ENTITIES.get(body) ?? match;
  });
}

// Converts an HTML fragment to plain text: drops <script>/<style> blocks (content
// and all), turns <br> into newlines, then strips remaining tags.
//
// Order matters for sanitization. Entities are decoded *first* so an entity-encoded
// tag (e.g. `&lt;script&gt;…&lt;/script&gt;`) becomes a real tag and is removed by the
// stripping below — decoding last would reconstruct that markup *after* stripping and
// hand it back as output (CodeQL js/incomplete-multi-character-sanitization). Every
// multi-character removal then runs in a fixpoint loop so a single pass can't leave a
// reconstructable pattern (e.g. nested `<script><script>…` blocks, or `<scr<script>ipt>`),
// and any leftover angle brackets are dropped so no `<script` fragment can survive. A
// genuine literal `<`/`>` in lyric text is a rare casualty of that final cleanup — an
// acceptable trade for plain-text output that can never carry markup.
function htmlToText(html: string): string {
  let text = decodeHtmlEntities(html);

  // Drop <script>/<style> blocks (content and all). Looped: one pass can leave a
  // reconstructable block (e.g. nested <script><script>…</script></script>).
  let previousBlocks: string;
  do {
    previousBlocks = text;
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  } while (text !== previousBlocks);

  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags. Looped for the same reason (e.g. `<scr<script>ipt>`).
  let previousTags: string;
  do {
    previousTags = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previousTags);

  text = text.replace(/[<>]/g, '');
  return text.trim();
}

// Extracts plain text from <div data-lyrics-container> elements using a
// balanced-bracket depth counter to handle nested divs correctly.
// The previous regex approach used non-greedy matching which stopped at the
// first inner </div>, capturing only the header block Genius now prepends.
function extractLyricsFromHtml(html: string): string | null {
  const OPEN_TAG = 'data-lyrics-container';
  const parts: string[] = [];
  let pos = 0;

  while (pos < html.length) {
    const attrIdx = html.indexOf(OPEN_TAG, pos);
    if (attrIdx === -1) break;

    const tagEnd = html.indexOf('>', attrIdx);
    if (tagEnd === -1) break;

    let depth = 1;
    let cursor = tagEnd + 1;
    let closingStart = -1;

    while (depth > 0 && cursor < html.length) {
      const nextOpen = html.indexOf('<div', cursor);
      const nextClose = html.indexOf('</div>', cursor);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cursor = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) closingStart = nextClose;
        cursor = nextClose + 6;
      }
    }

    if (closingStart !== -1) {
      const raw = html.slice(tagEnd + 1, closingStart);
      const text = htmlToText(raw);
      if (text) parts.push(text);
      pos = closingStart + 6;
    } else {
      pos = tagEnd + 1;
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// Rejects content that is known garbage: Genius header blocks, bare title
// matches, and oversized results (books/articles scraped instead of lyrics).
function isValidGeniusLyrics(text: string): boolean {
  if (text.length > 15_000) return false;
  if (/^\d+\s+Contributor/i.test(text)) return false;
  if (/\bLyrics\s*$/.test(text)) return false;
  return true;
}

function normalizeArtistName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Browser-like User-Agent sent on every Genius request. Unlike DISCOGS_USER_AGENT /
// ACOUSTICBRAINZ_USER_AGENT — which are polite identifying strings — this default must
// look like a real browser: Genius's Cloudflare edge returns 403 to requests carrying a
// bot-like or empty UA (especially from datacenter IPs like the prod EC2 host), which is
// the root cause of the "403-limited" fallback (issue #195). Overridable via
// GENIUS_USER_AGENT for when the string needs refreshing without a code change.
const DEFAULT_GENIUS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Fetch lyrics from Genius: search API to find the song page, then scrape HTML.
 * Returns lyrics text or null if not found/valid. Throws on network/API errors.
 * `userAgent` is sent on both requests to clear Genius's Cloudflare bot check (#195).
 */
async function fetchGenius(
  token: string,
  userAgent: string,
  artistName: string,
  title: string,
): Promise<string | null> {
  const searchUrl = new URL('https://api.genius.com/search');
  searchUrl.searchParams.set('q', `${artistName} ${title}`);

  const searchResponse = await fetch(searchUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent,
      Accept: 'application/json',
    },
  });

  if (!searchResponse.ok) throw new Error(`Genius search returned ${searchResponse.status}`);

  const searchData = (await searchResponse.json()) as GeniusSearchResponse;
  const firstHit = searchData.response.hits[0];

  // Genius also indexes books and articles — only accept song results.
  if (!firstHit || firstHit.type !== 'song') return null;

  // Reject hits where the primary artist doesn't fuzzy-match the query artist
  // to avoid storing lyrics for completely different songs.
  const geniusArtist = normalizeArtistName(firstHit.result.primary_artist.name);
  const queryArtist = normalizeArtistName(artistName);
  if (queryArtist && !geniusArtist.includes(queryArtist) && !queryArtist.includes(geniusArtist)) {
    return null;
  }

  const pageResponse = await fetch(firstHit.result.url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!pageResponse.ok) throw new Error(`Genius page returned ${pageResponse.status}`);

  const html = await pageResponse.text();
  const lyrics = extractLyricsFromHtml(html);
  if (!lyrics || !isValidGeniusLyrics(lyrics)) return null;
  return lyrics;
}

/**
 * Enrich all Track nodes that lack lyrics.
 * Queries LRCLIB first; falls back to Genius when GENIUS_TOKEN is set.
 * Missing lyrics are logged and skipped — never crashes the caller.
 */
export async function enrichLyrics(
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<LyricsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  log.info('[lyrics] Starting lyrics enrichment');

  let tracks;
  try {
    tracks = await getUnenrichedTracks(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[lyrics] Failed to fetch unenriched tracks: ${msg}`);
    return { enriched: 0, skipped: 0, failed: 1, durationMs: Date.now() - startTime };
  }
  const total = tracks.length;
  log.info(`[lyrics] Found ${total} tracks without lyrics`);
  onProgress(0, total);

  const geniusToken = process.env['GENIUS_TOKEN'];
  const geniusUserAgent = process.env['GENIUS_USER_AGENT'] || DEFAULT_GENIUS_USER_AGENT;

  let i = 0;
  for (const track of tracks) {
    i++;
    if (i % 25 === 0) onProgress(i, total);
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
      try {
        await setTrackLyrics(
          driver,
          track.releaseDiscogsId,
          track.position,
          lrclibResult,
          'lrclib',
        );
        enriched++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[lyrics] Failed to write LRCLIB lyrics for "${track.title}": ${msg}`);
        failed++;
      }
      continue;
    }

    // LRCLIB returned null (404) — try Genius fallback
    if (geniusToken) {
      try {
        const geniusResult = await fetchGenius(
          geniusToken,
          geniusUserAgent,
          track.artistName ?? '',
          track.title,
        );
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
          // Both sources came up empty — stamp the attempt so we retry at most once per
          // staleness window, not every run.
          await markLyricsFetched(driver, track.releaseDiscogsId, track.position);
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[lyrics] Genius failed for "${track.title}": ${msg}`);
        failed++;
      }
    } else {
      log.debug?.('[lyrics] GENIUS_TOKEN not set — skipping Genius fallback');
      // No Genius fallback configured and LRCLIB had nothing — stamp the attempt so we
      // retry at most once per staleness window rather than re-hitting LRCLIB every run.
      try {
        await markLyricsFetched(driver, track.releaseDiscogsId, track.position);
        skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[lyrics] Failed to mark "${track.title}" fetched: ${msg}`);
        failed++;
      }
    }
  }

  onProgress(total, total);
  const durationMs = Date.now() - startTime;
  log.info(
    `[lyrics] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
