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
import { DEFAULT_OUTBOUND_TIMEOUT_MS, resolveOutboundTimeoutMs } from './outbound-timeout.js';

export interface LrclibClientConfig {
  /**
   * Identifying User-Agent. LRCLIB's API explicitly asks callers to send an app
   * name / version / contact string — unlike Genius, this is a polite identifier,
   * not a browser disguise.
   */
  userAgent: string;
  /** Trailing sleep after every successful request. Concurrency is the rate ceiling, so this is small. */
  delayMs: number;
  /** Minimum backoff on a retryable status. Defaults to 1000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Per-request timeout in ms (#357). Falls back to the shared fetch default when omitted. */
  timeoutMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  /** Optional structured logger; defaults to console when omitted. Pass app.log in production. */
  logger?: Logger;
  /** Disable the per-source circuit breaker (#242); on by default. */
  disableCircuitBreaker?: boolean;
}

interface LrclibResponse {
  plainLyrics?: string | null;
  // LRCLIB's authoritative instrumental flag. `true` means the track has no lyrics by
  // nature (issue #246) — a terminal answer, never a miss to retry or fall back on.
  instrumental?: boolean;
  // What LRCLIB matched on. Echoed back on every 200 — used by the match-confidence gate
  // (#248) to confirm we got the right recording, not a same-title different version.
  trackName?: string | null;
  artistName?: string | null;
  duration?: number | null;
}

/**
 * What a 200 from LRCLIB carries: the plain lyrics (null when absent), whether LRCLIB marked the
 * track instrumental (#246), and the title/artist/duration LRCLIB *matched on* (#248) so the caller
 * can confirm the recording. `getLyrics` returns this on 200 and `null` only on a 404 (no record at
 * all). An instrumental track comes back as `{ lyrics: null, instrumental: true, ... }`, which the
 * caller treats as a terminal classification rather than a miss.
 */
export interface LrclibResult {
  lyrics: string | null;
  instrumental: boolean;
  matchedTitle: string | null;
  matchedArtist: string | null;
  matchedDurationSeconds: number | null;
}

const BASE_URL = 'https://lrclib.net/api/get';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_USER_AGENT = 'liner-notes/1.0 (+https://github.com/macamp0328/liner-notes)';
const DEFAULT_DELAY_MS = 0;

/**
 * HTTP client for LRCLIB's free, key-less lyrics API — the primary lyrics source.
 *
 * Promoted from a raw `fetch()` to a hardened client (#247) so it matches the other
 * external clients: bounded retry on transient/5xx via the shared `createRateLimitedFetch`
 * core, capped backoff, and an identifying User-Agent (which LRCLIB requests). A transient
 * `LRCLIB 504` that used to drop a candidate now retries instead.
 */
export class LrclibClient {
  private readonly userAgent: string;
  private readonly rlFetch: RateLimitedFetch;
  private readonly breaker: CircuitBreaker | undefined;

  constructor(config: LrclibClientConfig) {
    this.userAgent = config.userAgent;
    this.breaker =
      config.disableCircuitBreaker === true
        ? undefined
        : buildCircuitBreaker('lrclib', config.logger);
    this.rlFetch = createRateLimitedFetch({
      label: 'lrclib-client',
      apiName: 'LRCLIB API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      retryStatuses: [429, 500, 502, 503, 504],
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
      ...(this.breaker !== undefined ? { breaker: this.breaker } : {}),
    });
  }

  /** Current circuit-breaker state for run-summary surfacing; closed when the breaker is off. */
  breakerSnapshot(): CircuitBreakerSnapshot {
    return this.breaker?.snapshot() ?? closedSnapshot('lrclib');
  }

  /**
   * Look up a track on LRCLIB. Returns an {@link LrclibResult} on 200 (carrying the plain
   * lyrics — null when absent — and the authoritative `instrumental` flag, #246), `null` on a
   * 404 (no record at all), and throws on any other non-ok status (after the retry budget is
   * spent — a retryable status exhausts to `RetriesExhaustedError`).
   */
  async getLyrics(artistName: string, title: string): Promise<LrclibResult | null> {
    const url = new URL(BASE_URL);
    url.searchParams.set('track_name', title);
    url.searchParams.set('artist_name', artistName);

    let response: Response;
    try {
      response = await this.rlFetch(url.toString(), {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      });
    } catch (err) {
      // An open breaker is LRCLIB's "no record" outcome — null, like a 404 miss.
      if (err instanceof CircuitBreakerOpenError) return null;
      throw err;
    }

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`LRCLIB API error ${response.status} for ${url.toString()}`);
    }

    const data = (await response.json()) as LrclibResponse;
    return {
      lyrics: data.plainLyrics ?? null,
      instrumental: data.instrumental === true,
      matchedTitle: data.trackName ?? null,
      matchedArtist: data.artistName ?? null,
      matchedDurationSeconds: typeof data.duration === 'number' ? data.duration : null,
    };
  }
}

/**
 * Build an {@link LrclibClient} from environment variables. LRCLIB needs no key, so this
 * always returns a client. `LRCLIB_USER_AGENT` overrides the polite default identifier;
 * `LRCLIB_REQUEST_DELAY_MS` overrides the per-request spacing (clamped — malformed/negative
 * values fall back to the default).
 */
export function buildLrclibClientFromEnv(logger?: Logger): LrclibClient {
  const userAgent = process.env['LRCLIB_USER_AGENT'] || DEFAULT_USER_AGENT;
  const parsed = parseInt(process.env['LRCLIB_REQUEST_DELAY_MS'] ?? '', 10);
  const delayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;
  return new LrclibClient({
    userAgent,
    delayMs,
    timeoutMs: resolveOutboundTimeoutMs(DEFAULT_OUTBOUND_TIMEOUT_MS),
    ...(logger !== undefined ? { logger } : {}),
  });
}
