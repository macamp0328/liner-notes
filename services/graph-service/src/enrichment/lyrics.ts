import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedTracks,
  setTrackLyrics,
  markLyricsFetched,
  markTrackInstrumental,
  markTrackProbableInstrumental,
  type UnenrichedTrack,
} from '../db/lyrics-repository.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import {
  extractLyricsFromHtml,
  stripGeniusHeader,
  isValidGeniusLyrics,
  normalizeArtistName,
} from './lyrics-extract.js';

export type LyricsEnrichmentSummary = EnrichmentSummary;

interface LrclibResponse {
  plainLyrics?: string | null;
  // LRCLIB's authoritative instrumental flag. `true` means the track has no lyrics by
  // nature (issue #246) — a terminal answer, never a miss to retry or fall back on.
  instrumental?: boolean;
}

/**
 * What a 200 from LRCLIB carries: the plain lyrics (null when absent) and whether LRCLIB
 * marked the track instrumental. `fetchLrclib` returns this on 200 and `null` only on 404
 * (no record at all → fall through to the AcousticBrainz signal / Genius).
 */
interface LrclibResult {
  lyrics: string | null;
  instrumental: boolean;
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
 * Returns a {@link LrclibResult} on 200 (carrying the authoritative `instrumental` flag —
 * #246), `null` on 404 (no record), throws on unexpected errors. An instrumental track
 * comes back as `{ lyrics: null, instrumental: true }`, which the caller treats as a
 * terminal classification rather than a miss.
 */
async function fetchLrclib(artistName: string, title: string): Promise<LrclibResult | null> {
  const url = new URL('https://lrclib.net/api/get');
  url.searchParams.set('track_name', title);
  url.searchParams.set('artist_name', artistName);

  const response = await fetch(url.toString());

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`);

  const data = (await response.json()) as LrclibResponse;
  return { lyrics: data.plainLyrics ?? null, instrumental: data.instrumental === true };
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
 * A non-OK HTTP response from Genius, carrying the status code as a typed property so
 * callers can distinguish an expected Cloudflare bot-block (403) from a genuinely
 * unexpected failure (5xx, …) without parsing the message string. The message text
 * mirrors the prior plain-Error format so existing log lines are unchanged.
 */
class GeniusHttpError extends Error {
  constructor(
    readonly status: number,
    readonly phase: 'search' | 'page',
  ) {
    super(`Genius ${phase} returned ${status}`);
    this.name = 'GeniusHttpError';
  }
}

/**
 * Genius's Cloudflare edge returns 403 to the prod EC2 datacenter IP for every request
 * (#240) — an expected, environmental dead-end, not a code fault. Treating it as expected
 * keeps it at `warn`, below the level-50 threshold that feeds the prod error alarm (#243).
 * Every other failure (5xx, parse crash, network error) stays unexpected → `error`.
 */
function isExpectedGeniusBlock(err: unknown): boolean {
  return err instanceof GeniusHttpError && err.status === 403;
}

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
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!searchResponse.ok) throw new GeniusHttpError(searchResponse.status, 'search');

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
  if (!pageResponse.ok) throw new GeniusHttpError(pageResponse.status, 'page');

  const html = await pageResponse.text();
  const extracted = extractLyricsFromHtml(html);
  // Strip Genius's contributor/title header before validating (#253); a pure-header
  // page collapses to "" and is rejected by the falsy guard below.
  const lyrics = extracted ? stripGeniusHeader(extracted) : null;
  if (!lyrics || !isValidGeniusLyrics(lyrics)) return null;
  return lyrics;
}

/**
 * A terminal classification of a track's lyrics (issue #246). `resolve` returns one of these
 * or `null` (= not-found, retry per staleness):
 * - `resolved` — lyrics found, with the source that provided them.
 * - `instrumental` — LRCLIB's authoritative `instrumental` flag; no lyrics exist.
 * - `probable-instrumental` — LRCLIB has no record, but the AcousticBrainz `voiceInstrumental`
 *   we already store classifies the track instrumental. Lower certainty than `instrumental`.
 *
 * All three flow through `write` (the runner counts them `enriched`); only `null` reaches
 * `markAttempted`. The two instrumental kinds are terminal — excluded from candidate retries.
 */
type LyricsResolved =
  | { kind: 'resolved'; lyrics: string; source: 'lrclib' | 'genius' }
  | { kind: 'instrumental' }
  | { kind: 'probable-instrumental' };

/**
 * Enrich all Track nodes that lack lyrics.
 * Resolution order (issue #246): LRCLIB's instrumental flag → LRCLIB lyrics → the stored
 * AcousticBrainz `voiceInstrumental` signal → Genius fallback (when GENIUS_TOKEN is set) →
 * not-found. The two instrumental classifications are terminal and **short-circuit before
 * Genius**, which is where most of the wasted Genius-call / 403-spam savings come from
 * (#240/#243). Missing lyrics are logged and skipped — never crashes the caller.
 *
 * Stage-ordering caveat: `voiceInstrumental` is populated by the `track-acousticbrainz`
 * enrichment, which finishes long after `lyrics` in a fresh reload (it deps the slow
 * `track-musicbrainz` stage). So `probable-instrumental` rarely fires on the primary reload —
 * it classifies on the later staleness re-run. We deliberately do NOT make lyrics depend on
 * track-acousticbrainz (that would chain it behind the ~2.5hr stage and defeat #176's
 * early-lane design); a `not-found` track stays re-eligible to be upgraded later.
 *
 * The multi-source fallback lives inside `resolve`, so a single track can only ever be
 * counted `failed` once (LRCLIB throwing short-circuits the Genius attempt) — the
 * per-item loop, isolation, and stamp-on-attempt contract are owned by {@link runEnrichment}.
 */
export async function enrichLyrics(
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<LyricsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const geniusToken = process.env['GENIUS_TOKEN'];
  const geniusUserAgent = process.env['GENIUS_USER_AGENT'] || DEFAULT_GENIUS_USER_AGENT;

  const stage: EnrichmentStage<UnenrichedTrack, LyricsResolved> = {
    name: 'lyrics',
    selectCandidates: (d) => getUnenrichedTracks(d),
    async resolve(track) {
      const lrclib = await fetchLrclib(track.artistName ?? '', track.title);
      if (lrclib !== null) {
        // LRCLIB's authoritative instrumental flag — terminal, no Genius (#246).
        if (lrclib.instrumental) return { kind: 'instrumental' };
        if (lrclib.lyrics !== null)
          return { kind: 'resolved', lyrics: lrclib.lyrics, source: 'lrclib' };
      }

      // LRCLIB had no usable lyrics (404, or a record with no plain lyrics). Before spending a
      // Genius call, trust the AcousticBrainz signal we already store: a track classified
      // instrumental there is probably lyric-less, so short-circuit (most of the #240/#243 saving).
      if (track.voiceInstrumental === 'instrumental') return { kind: 'probable-instrumental' };

      // Try Genius fallback when configured.
      if (!geniusToken) {
        log.debug?.('[lyrics] GENIUS_TOKEN not set — skipping Genius fallback');
        return null;
      }
      const geniusResult = await fetchGenius(
        geniusToken,
        geniusUserAgent,
        track.artistName ?? '',
        track.title,
      );
      return geniusResult === null
        ? null
        : { kind: 'resolved', lyrics: geniusResult, source: 'genius' };
    },
    write: (d, track, resolved) => {
      if (resolved.kind === 'resolved') {
        return setTrackLyrics(
          d,
          track.releaseDiscogsId,
          track.position,
          resolved.lyrics,
          resolved.source,
        );
      }
      if (resolved.kind === 'instrumental') {
        return markTrackInstrumental(d, track.releaseDiscogsId, track.position);
      }
      return markTrackProbableInstrumental(d, track.releaseDiscogsId, track.position);
    },
    markAttempted: (d, track) => markLyricsFetched(d, track.releaseDiscogsId, track.position),
    isExpectedError: isExpectedGeniusBlock,
    describeItem: (track) => `"${track.title}"`,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
