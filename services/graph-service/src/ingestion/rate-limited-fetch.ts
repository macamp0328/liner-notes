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
 * Loop semantics, per attempt 0..maxRetries:
 * - fetch throws: transient codes retry with backoff; non-transient errors and the final
 *   attempt rethrow the ORIGINAL error unchanged.
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
    random = Math.random,
    sleep = defaultSleep,
    logger = console,
    breaker,
  } = config;

  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (breaker && !breaker.allowRequest()) {
      throw new CircuitBreakerOpenError(breaker.source);
    }

    let attempt = 0;
    let currentDelay = backoffBaseMs;

    while (attempt <= maxRetries) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        const netCode = transientNetworkCode(err);
        // A non-transient error (and the final-attempt rethrow) leaves the loop. Only a transient
        // exhaustion is the source's verdict; a non-transient throw is a programming/abort error
        // the breaker must not count.
        if (netCode === null) throw err;
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
