import type { Logger } from './rate-limited-fetch.js';

/**
 * The verdict a single request settles to, from the breaker's point of view.
 * - `success` — a usable response (2xx). Resets the consecutive-fatal counter.
 * - `miss` — the source answered but had no data (404, empty hit, other 4xx). NOT a failure;
 *   it still proves the source is alive, so it resets the consecutive counter too.
 * - `transient` — a 429/5xx/network blip already handled by the client's retry/backoff. It is
 *   invisible to the consecutive counter (neither trips nor resets) so a flaky 503 between two
 *   fatals can't rescue a genuinely-blocked source.
 * - `fatal` — a deterministic block (401/403/451, a bot-block HTML challenge). Consecutive
 *   occurrences trip the breaker — they mean "this source keeps failing identically all run".
 */
export type Outcome = 'success' | 'miss' | 'transient' | 'fatal';

/**
 * The signals {@link classifyOutcome} understands. Each caller supplies exactly the fields it
 * has: the shared-fetch loop passes a response `status`; the lyrics path maps a typed HTTP error's
 * status the same way; `transient` is set when the client already classified a retry-exhausted or
 * network error; `htmlChallenge` flags a 200-but-HTML bot-block; `ok` short-circuits to success.
 */
export interface OutcomeSignal {
  status?: number;
  htmlChallenge?: boolean;
  ok?: boolean;
  transient?: boolean;
}

/** Stable per-source keys used in logs, snapshots, and the reload-status `counts` map. */
export type BreakerSource =
  | 'discogs'
  | 'musicbrainz'
  | 'acousticbrainz'
  | 'deezer'
  | 'wikidata'
  | 'genius'
  | 'lrclib';

const FATAL_STATUSES = new Set([401, 403, 451]);

/**
 * Map a single request's signals to an {@link Outcome}. Precedence matters: an already-classified
 * `transient` wins over any status; a 200-but-HTML bot-block is fatal despite the 2xx; then status
 * decides; finally `ok` and an ambiguous fallback both resolve to non-tripping outcomes so the
 * breaker never opens on something it can't positively call a block.
 */
export function classifyOutcome(signal: OutcomeSignal): Outcome {
  if (signal.transient === true) return 'transient';
  if (signal.htmlChallenge === true) return 'fatal';

  const { status } = signal;
  if (status !== undefined) {
    if (FATAL_STATUSES.has(status)) return 'fatal';
    if (status === 404) return 'miss';
    if (status === 429 || status >= 500) return 'transient';
    if (status >= 200 && status < 300) return 'success';
    // Any other status (400/422/3xx) is a per-request problem, not a source outage — never trip.
    return 'miss';
  }

  if (signal.ok === true) return 'success';
  return 'miss';
}

/**
 * Thrown by the shared fetch loop when the source's breaker is open: the request is short-circuited
 * without a network call. Auxiliary clients map it to their own "no data" return (it looks like a
 * miss); the critical Discogs path lets it propagate.
 */
export class CircuitBreakerOpenError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`circuit breaker open for source "${source}" — skipping request`);
    this.name = 'CircuitBreakerOpenError';
    this.source = source;
  }
}

export interface CircuitBreakerOptions {
  /** Stable source key, e.g. 'genius'. */
  source: string;
  /** Consecutive fatals before opening. Defaults to {@link DEFAULT_CIRCUIT_BREAKER_THRESHOLD}. */
  threshold?: number;
  /**
   * Optional half-open probe: ms to stay open before allowing one trial request. Undefined → stay
   * open for the whole run (the right choice for a datacenter-IP block / expired token).
   */
  cooldownMs?: number;
  /** Structured logger; defaults to console. The single trip line is logged at `warn`. */
  logger?: Logger;
  /** Injectable clock for deterministic half-open tests; defaults to Date.now. */
  now?: () => number;
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerSnapshot {
  source: string;
  state: CircuitBreakerState;
  /** True while the breaker is not fully closed (open or probing). */
  open: boolean;
  consecutiveFatals: number;
  /** Cumulative fatals this run, for observability — survives a reset. */
  fatalCount: number;
  /** Timestamp of the most recent open transition, or null if never tripped. */
  trippedAt: number | null;
}

export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * A per-source circuit breaker, consulted before each request ({@link allowRequest}) and updated
 * after ({@link record}). It opens after N consecutive fatal responses, logging the trip ONCE at
 * `warn`, and thereafter short-circuits the source for the rest of the run (or until a half-open
 * probe, when `cooldownMs` is set). Scope is the breaker instance's lifetime — clients build one
 * per run, so it is naturally run-scoped.
 */
export class CircuitBreaker {
  readonly source: string;
  private readonly threshold: number;
  private readonly cooldownMs: number | undefined;
  private readonly log: Logger;
  private readonly now: () => number;

  private state: CircuitBreakerState = 'closed';
  private consecutiveFatals = 0;
  private fatalCount = 0;
  private trippedAt: number | null = null;

  constructor(opts: CircuitBreakerOptions) {
    this.source = opts.source;
    this.threshold = opts.threshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.cooldownMs = opts.cooldownMs;
    this.log = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Consult before making a request. Returns false when open (the caller must short-circuit). When
   * `cooldownMs` is set and has elapsed since the trip, transitions open → half-open and returns
   * true to permit a single recovery probe. Never logs.
   */
  allowRequest(): boolean {
    if (this.state === 'open') {
      if (this.cooldownMs !== undefined && this.trippedAt !== null) {
        if (this.now() - this.trippedAt >= this.cooldownMs) {
          this.state = 'half-open';
          return true;
        }
      }
      return false;
    }
    return true;
  }

  /**
   * Record a settled request's {@link Outcome}. success/miss reset the consecutive counter (and
   * close a half-open probe); transient is a no-op; a fatal increments and, on reaching the
   * threshold (or failing a half-open probe), opens the breaker and logs the trip once.
   */
  record(outcome: Outcome): void {
    if (outcome === 'transient') return;

    if (outcome === 'success' || outcome === 'miss') {
      this.consecutiveFatals = 0;
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.trippedAt = null;
      }
      return;
    }

    // fatal
    this.fatalCount++;
    this.consecutiveFatals++;
    if (this.state === 'half-open') {
      this.trip();
    } else if (this.state === 'closed' && this.consecutiveFatals >= this.threshold) {
      this.trip();
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      source: this.source,
      state: this.state,
      open: this.state !== 'closed',
      consecutiveFatals: this.consecutiveFatals,
      fatalCount: this.fatalCount,
      trippedAt: this.trippedAt,
    };
  }

  private trip(): void {
    this.state = 'open';
    this.trippedAt = this.now();
    this.log.warn(
      `[circuit-breaker] source "${this.source}" open after ${this.consecutiveFatals} consecutive ` +
        `fatal/blocked responses — skipping it for the rest of this run`,
    );
  }
}

/**
 * Resolve the consecutive-fatal threshold from `CIRCUIT_BREAKER_THRESHOLD`. Mirrors
 * `resolveConcurrency`: an all-digits value is honored (clamped to ≥1), anything malformed falls
 * back to {@link DEFAULT_CIRCUIT_BREAKER_THRESHOLD} rather than `parseInt`-ing its leading digits.
 */
export function resolveCircuitBreakerThreshold(): number {
  const raw = process.env['CIRCUIT_BREAKER_THRESHOLD']?.trim() ?? '';
  return /^[0-9]+$/.test(raw) ? Math.max(1, Number(raw)) : DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
}

/**
 * Resolve the optional half-open cooldown from `CIRCUIT_BREAKER_COOLDOWN_MS`. Returns a positive
 * millisecond value, or undefined (stay open for the run) when unset, zero, or malformed.
 */
export function resolveCircuitBreakerCooldownMs(): number | undefined {
  const raw = process.env['CIRCUIT_BREAKER_COOLDOWN_MS']?.trim() ?? '';
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > 0 ? value : undefined;
}
