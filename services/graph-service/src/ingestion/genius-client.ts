import {
  createRateLimitedFetch,
  type Logger,
  type RateLimitedFetch,
} from './rate-limited-fetch.js';
import {
  buildCircuitBreaker,
  closedSnapshot,
  CircuitBreakerOpenError,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
import {
  extractLyricsFromHtml,
  stripGeniusHeader,
  isValidGeniusLyrics,
  normalizeArtistName,
} from '../enrichment/lyrics-extract.js';

// Browser-like User-Agent sent on every Genius request. Unlike DISCOGS_USER_AGENT /
// LRCLIB_USER_AGENT — which are polite identifying strings — this default must look like a
// real browser: Genius's Cloudflare edge returns 403 to requests carrying a bot-like or empty
// UA (especially from datacenter IPs like the prod EC2 host), which is the root cause of the
// "403-limited" fallback (issue #195). Overridable via GENIUS_USER_AGENT for when the string
// needs refreshing without a code change.
export const DEFAULT_GENIUS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * A non-OK HTTP response from Genius, carrying the status code as a typed property so callers
 * can distinguish an expected Cloudflare bot-block (403) from a genuinely unexpected failure
 * without parsing the message string. The message text mirrors the prior plain-Error format so
 * existing log lines are unchanged.
 */
export class GeniusHttpError extends Error {
  constructor(
    readonly status: number,
    readonly phase: 'search' | 'page',
  ) {
    super(`Genius ${phase} returned ${status}`);
    this.name = 'GeniusHttpError';
  }
}

/**
 * Genius's Cloudflare edge returns 403 to the prod EC2 datacenter IP for every request (#240) —
 * an expected, environmental dead-end, not a code fault. Treating it as expected keeps it at
 * `warn`, below the level-50 threshold that feeds the prod error alarm (#243). Every other
 * failure (5xx, parse crash, network error) stays unexpected → `error`.
 */
export function isExpectedGeniusBlock(err: unknown): boolean {
  return err instanceof GeniusHttpError && err.status === 403;
}

export interface GeniusClientConfig {
  /** Genius API token (Bearer auth on the search call). */
  token: string;
  /** Browser-like User-Agent sent on both requests to clear Genius's Cloudflare bot check (#195). */
  userAgent: string;
  /** Trailing sleep after every successful request. Concurrency is the rate ceiling, so this is small. */
  delayMs: number;
  /** Minimum backoff on a retryable status. Defaults to 1000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  /** Optional structured logger; defaults to console when omitted. Pass app.log in production. */
  logger?: Logger;
  /** Disable the per-source circuit breaker (#242); on by default. */
  disableCircuitBreaker?: boolean;
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

const SEARCH_URL = 'https://api.genius.com/search';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
// 403 is deliberately NOT retried: in prod it is a permanent Cloudflare datacenter-IP block
// (#195/#240), so retrying only burns the budget. It surfaces as an expected GeniusHttpError(403).
const RETRY_STATUSES = [429, 500, 502, 503, 504];

/**
 * HTTP client for Genius — the lyrics fallback used only when LRCLIB has no match.
 *
 * Promoted from raw `fetch()` calls to a hardened client (#247) sharing the
 * `createRateLimitedFetch` core (bounded retry on transient/5xx, capped backoff). It is the
 * canonical integration surface for the circuit breaker (#242). `getLyrics` encapsulates the
 * whole lookup — search → song-type guard → artist fuzzy-match → page scrape → extract → strip →
 * validate — so callers see only `string | null` (or a thrown `GeniusHttpError`/exhaustion error).
 */
export class GeniusClient {
  private readonly token: string;
  private readonly userAgent: string;
  private readonly rlFetch: RateLimitedFetch;
  private readonly breaker: CircuitBreaker | undefined;

  constructor(config: GeniusClientConfig) {
    this.token = config.token;
    this.userAgent = config.userAgent;
    this.breaker =
      config.disableCircuitBreaker === true
        ? undefined
        : buildCircuitBreaker('genius', config.logger);
    this.rlFetch = createRateLimitedFetch({
      label: 'genius-client',
      apiName: 'Genius API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      retryStatuses: RETRY_STATUSES,
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
      ...(this.breaker !== undefined ? { breaker: this.breaker } : {}),
    });
  }

  /** Current circuit-breaker state for run-summary surfacing; closed when the breaker is off. */
  breakerSnapshot(): CircuitBreakerSnapshot {
    return this.breaker?.snapshot() ?? closedSnapshot('genius');
  }

  /**
   * Look up lyrics for a track via Genius. Returns the lyrics text, or `null` when there is no
   * usable result (no hit, non-song, artist mismatch, or invalid/empty page). Throws on
   * network/API errors — a non-retryable status (notably the expected 403 bot-block) as a
   * {@link GeniusHttpError}; a retryable status that spends the budget as a `RetriesExhaustedError`.
   */
  async getLyrics(artistName: string, title: string): Promise<string | null> {
    try {
      return await this.lookupLyrics(artistName, title);
    } catch (err) {
      // An open breaker is a clean no-hit (→ not-found, stamped) — not an error to propagate.
      if (err instanceof CircuitBreakerOpenError) return null;
      throw err;
    }
  }

  private async lookupLyrics(artistName: string, title: string): Promise<string | null> {
    const searchUrl = new URL(SEARCH_URL);
    searchUrl.searchParams.set('q', `${artistName} ${title}`);

    const searchResponse = await this.rlFetch(searchUrl.toString(), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': this.userAgent,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!searchResponse.ok) throw new GeniusHttpError(searchResponse.status, 'search');

    const searchData = (await searchResponse.json()) as GeniusSearchResponse;
    const firstHit = searchData.response.hits[0];

    // Genius also indexes books and articles — only accept song results.
    if (!firstHit || firstHit.type !== 'song') return null;

    // Reject hits where the primary artist doesn't fuzzy-match the query artist to avoid storing
    // lyrics for completely different songs.
    const geniusArtist = normalizeArtistName(firstHit.result.primary_artist.name);
    const queryArtist = normalizeArtistName(artistName);
    if (queryArtist && !geniusArtist.includes(queryArtist) && !queryArtist.includes(geniusArtist)) {
      return null;
    }

    const pageResponse = await this.rlFetch(firstHit.result.url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pageResponse.ok) throw new GeniusHttpError(pageResponse.status, 'page');

    const html = await pageResponse.text();
    const extracted = extractLyricsFromHtml(html);
    // Strip Genius's contributor/title header before validating (#253); a pure-header page
    // collapses to "" and is rejected by the falsy guard below.
    const lyrics = extracted ? stripGeniusHeader(extracted) : null;
    if (!lyrics || !isValidGeniusLyrics(lyrics)) return null;
    return lyrics;
  }
}

/**
 * Build a {@link GeniusClient} from environment variables, or `null` when `GENIUS_TOKEN` is
 * unset (the prod path — Genius 403s the datacenter IP, so prod leaves it unconfigured and
 * harvests Genius out-of-band). `GENIUS_USER_AGENT` overrides the default browser UA.
 */
export function buildGeniusClientFromEnv(logger?: Logger): GeniusClient | null {
  const token = process.env['GENIUS_TOKEN'];
  if (!token) return null;
  const userAgent = process.env['GENIUS_USER_AGENT'] || DEFAULT_GENIUS_USER_AGENT;
  return new GeniusClient({
    token,
    userAgent,
    delayMs: 0,
    ...(logger !== undefined ? { logger } : {}),
  });
}
