import { transientNetworkCode } from './network-errors.js';
import { jitteredBackoffMs } from './backoff.js';
import { CircuitBreaker, CircuitBreakerOpenError, classifyOutcome } from './circuit-breaker.js';

/** Minimal logger interface — satisfied by Fastify's app.log (pino) and by console. */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

/**
 * Thrown when a retryable response (429/503/…, or a `shouldRetryResponse` match) is still
 * occurring on the final allowed attempt. Transient network errors are NOT wrapped in this —
 * the original error is rethrown so callers can match on its message/code.
 */
export class RetriesExhaustedError extends Error {
  readonly url: string;

  constructor(apiName: string, maxRetries: number, url: string) {
    super(`${apiName}: exceeded max retries (${maxRetries}) for ${url}`);
    this.name = 'RetriesExhaustedError';
    this.url = url;
  }
}

export interface RateLimitedFetchConfig {
  /** Log prefix, e.g. 'discogs-client' → "[discogs-client] …". */
  label: string;
  /** Human-readable API name used in the exhaustion error, e.g. 'Discogs API'. */
  apiName: string;
  /**
   * Trailing sleep after every successful (ok) response — the per-instance request spacing
   * that keeps each API's rate budget. Deliberately NOT applied to error responses, matching
   * the pre-#225 per-client loops.
   */
  delayMs: number;
  /** Retry budget: total attempts = maxRetries + 1. */
  maxRetries: number;
  /** Initial backoff for the exponential schedule. */
  backoffBaseMs: number;
  /** Backoff ceiling. Defaults to 32 000 ms. */
  backoffCeilMs?: number;
  /** HTTP statuses retried with backoff (e.g. [429] or [429, 503]). Others are returned as-is. */
  retryStatuses: readonly number[];
  /**
   * Inspect a response whose status is NOT in retryStatuses; return a short reason string
   * (e.g. 'HTML response') to retry it on the same budget, or null to accept it as-is.
   * Used by Wikidata for ok-but-HTML maintenance pages.
   */
  shouldRetryResponse?: (res: Response) => string | null;
  /**
   * Per-request timeout in ms, bounding a stalled upstream well under undici's ~300s defaults.
   * A fresh `AbortSignal.timeout` is attached to every attempt. Clamps to {@link DEFAULT_TIMEOUT_MS}
   * when absent or not a finite positive number, so every request is always bounded.
   */
  timeoutMs?: number;
  /**
   * Injectable timeout-signal factory for fake-timer-free tests; defaults to `AbortSignal.timeout`.
   * Tests pass `() => new AbortController().signal` (a never-aborting signal) so real multi-second
   * timers don't leak into the vitest event loop — consistent with the injected `sleep`/`random`.
   */
  timeoutSignal?: (ms: number) => AbortSignal;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  /** Injectable sleep for fake-timer-free tests; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional structured logger; defaults to console. Pass app.log in production. */
  logger?: Logger;
  /**
   * Optional per-source circuit breaker (#242). When supplied, the loop consults it once before
   * the first fetch — throwing {@link CircuitBreakerOpenError} without a network call if open — and
   * records the final outcome once after the loop settles. Behaviour is byte-identical to a
   * breaker-less loop when omitted.
   */
  breaker?: CircuitBreaker;
}

export type RateLimitedFetch = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_BACKOFF_CEIL_MS = 32_000;

/** Fallback per-request timeout when a caller supplies none (or a non-positive/garbage value). */
const DEFAULT_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryReasonForStatus(status: number): string {
  if (status === 429) return 'Rate limited';
  if (status === 503) return 'Service unavailable';
  return 'HTTP error';
}

/**
 * One rate-limited fetch loop behind every external API client (#225). Owns request spacing
 * (per instance — each API keeps its own rate budget), exponential backoff with equal jitter
 * (#245), Retry-After handling, and transient-network retries. Clients stay URL-shaping +
 * response parsing over their own instance; every non-retryable response (404, 500, …) is
 * returned as-is so each client keeps its own status semantics and error messages.
 *
 * Every attempt is bounded by a fresh per-attempt timeout signal ({@link RateLimitedFetchConfig.timeoutMs},
 * default {@link DEFAULT_TIMEOUT_MS}) — a fresh signal per attempt because `AbortSignal.timeout`
 * counts from creation, so reusing one would shrink the budget across retries. A request timeout is
 * classified as transient (so the breaker counts it as a source blip) but **fails fast**: it is
 * rethrown on the first occurrence rather than consuming the retry budget. A genuinely wedged
 * upstream would otherwise burn maxRetries+1 full timeouts, and the enrichment staleness window
 * already retries un-stamped items on the next run, so an in-loop retry is mostly redundant cost.
 * A caller-initiated abort (init.signal → 'AbortError') stays non-transient and propagates.
 *
 * Loop semantics, per attempt 0..maxRetries:
 * - fetch throws: a request timeout records transient and rethrows immediately (fail-fast); other
 *   transient codes retry with backoff; non-transient errors and the final attempt rethrow the
 *   ORIGINAL error unchanged.
 * - status in retryStatuses (or shouldRetryResponse returns a reason): backoff floored at
 *   Retry-After, then the schedule advances from the un-jittered wait — so a server-specified
 *   wait raises subsequent backoff instead of being forgotten. On the final attempt this
 *   throws RetriesExhaustedError immediately: no further fetch will follow, so sleeping out a
 *   full Retry-After window first would be pure waste (and the warn would name an attempt
 *   that never happens).
 * - accepted ok response: trailing sleep(delayMs), then return the unconsumed Response.
 */
export function createRateLimitedFetch(config: RateLimitedFetchConfig): RateLimitedFetch {
  const {
    label,
    apiName,
    delayMs,
    maxRetries,
    backoffBaseMs,
    backoffCeilMs = DEFAULT_BACKOFF_CEIL_MS,
    retryStatuses,
    shouldRetryResponse,
    timeoutMs,
    timeoutSignal,
    random = Math.random,
    sleep = defaultSleep,
    logger = console,
    breaker,
  } = config;

  const effectiveTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const makeTimeoutSignal = timeoutSignal ?? ((ms: number): AbortSignal => AbortSignal.timeout(ms));

  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (breaker && !breaker.allowRequest()) {
      throw new CircuitBreakerOpenError(breaker.source);
    }

    let attempt = 0;
    let currentDelay = backoffBaseMs;

    while (attempt <= maxRetries) {
      let response: Response;
      try {
        // Fresh signal per attempt: AbortSignal.timeout counts from creation, so reusing one would
        // shrink the budget across retries. Compose with a caller-supplied signal when present.
        const timeoutSig = makeTimeoutSignal(effectiveTimeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSig]) : timeoutSig;
        response = await fetch(url, { ...init, signal });
      } catch (err) {
        const netCode = transientNetworkCode(err);
        // A non-transient error (and the final-attempt rethrow) leaves the loop. Only a transient
        // exhaustion is the source's verdict; a non-transient throw is a programming/abort error
        // the breaker must not count.
        if (netCode === null) throw err;
        // A request timeout is transient (breaker counts it) but fails fast — see the function
        // header. Logged here because the silent rethrow would otherwise hide a wedged upstream
        // (the normal retry path below logs each attempt; the caller only sees a generic failure).
        if (netCode === 'TimeoutError') {
          logger.warn(`[${label}] Request timed out after ${effectiveTimeoutMs}ms — failing fast`);
          breaker?.record('transient');
          throw err;
        }
        if (attempt >= maxRetries) {
          breaker?.record('transient');
          throw err;
        }
        const sleepMs = jitteredBackoffMs(currentDelay, { random });
        logger.warn(
          `[${label}] Network error (${netCode}) on attempt ${attempt + 1}/${maxRetries + 1} — waiting ${sleepMs}ms`,
        );
        await sleep(sleepMs);
        currentDelay = Math.min(Math.max(currentDelay, backoffBaseMs) * 2, backoffCeilMs);
        attempt++;
        continue;
      }

      const retryReason = retryStatuses.includes(response.status)
        ? retryReasonForStatus(response.status)
        : (shouldRetryResponse?.(response) ?? null);

      if (retryReason !== null) {
        if (attempt >= maxRetries) {
          breaker?.record('transient');
          throw new RetriesExhaustedError(apiName, maxRetries, url);
        }
        // Honour the server-specified Retry-After delay when present. Validate the parsed
        // value — a non-integer header produces NaN which Math.max propagates, effectively
        // disabling backoff. Fall back to 0 on invalid values.
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
        const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
        const waitMs = Math.max(currentDelay, retryAfterMs);
        const sleepMs = jitteredBackoffMs(waitMs, { retryAfterMs, random });
        logger.warn(
          `[${label}] ${retryReason} (${response.status}) on attempt ${attempt + 1}/${maxRetries + 1} — waiting ${sleepMs}ms`,
        );
        await sleep(sleepMs);
        currentDelay = Math.min(Math.max(waitMs, backoffBaseMs) * 2, backoffCeilMs);
        attempt++;
        continue;
      }

      if (response.ok) {
        await sleep(delayMs);
      }
      breaker?.record(classifyOutcome({ status: response.status }));
      return response;
    }

    throw new RetriesExhaustedError(apiName, maxRetries, url);
  };
}
