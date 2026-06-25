import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import { getShutdownSignal } from '../lifecycle/shutdown.js';
import { jitteredBackoffMs } from '../ingestion/backoff.js';
import { defaultSleep } from '../ingestion/rate-limited-fetch.js';

/**
 * The shared summary every per-item enrichment run returns. Stages that track extra
 * source-specific counters layer them on at their own boundary; these five are the
 * invariant the runner owns. `skipped` and `exhausted` are both "queried, no data" — the
 * difference is whether it can change: `skipped` is throttled (re-checked next window),
 * `exhausted` is terminal (a permanent marker is written, never re-checked). See #367.
 */
export interface EnrichmentSummary {
  enriched: number;
  /** Queried, no data, but it could appear later → throttled, re-checked next staleness window. */
  skipped: number;
  /** Queried, definitively & permanently no data → a terminal marker is written, never re-checked. */
  exhausted: number;
  failed: number;
  /**
   * How many transient failures the in-run retry sweep (#455) reclaimed — present only when a
   * stage passes `retry` to {@link runEnrichment} (undefined otherwise, so `JSON.stringify`
   * omits it for non-retry stages). `failed` already reflects post-sweep reality; this is the
   * operator-visible signal in `/reload/status` that distinguishes "0 transient failures" from
   * "N failures all recovered by the sweep" — i.e. that the upstream was flaky this run.
   */
  recovered?: number;
  durationMs: number;
}

/**
 * The third `resolve` outcome (issue #367): "queried, definitively & PERMANENTLY no data".
 * Distinct from `null` (empty-for-now, throttled) — a unique `Symbol`, so it can never collide
 * with a stage's `TResolved` payload (which may itself be an object/union). A stage returning
 * this MUST declare `markTerminal`; the runner throws otherwise (a silent fallback to the
 * throttle stamp would re-query permanent data forever — the #240-class waste this prevents).
 */
export const TERMINAL_EMPTY: unique symbol = Symbol('terminal-empty');

/**
 * A per-item enrichment stage. The stage declares only what varies — candidate
 * selection, the external lookup, and the writes — while {@link runEnrichment}
 * owns the loop invariants: per-item failure isolation, the stamp-on-attempt contract,
 * progress reporting, and summary aggregation (issue #222).
 *
 * The stamp-on-attempt contract the runner enforces (issues #89, #367):
 * - `resolve` returns data → `write` persists + stamps `*FetchedAt`, counted `enriched`.
 * - `resolve` returns `null` (queried, no data, but it could appear later) → `markAttempted`
 *   stamps `*FetchedAt` so the source is retried at most once per staleness window, counted `skipped`.
 * - `resolve` returns {@link TERMINAL_EMPTY} (queried, definitively & permanently no data) →
 *   `markTerminal` writes a permanent marker so the item is never re-checked, counted `exhausted`.
 * - `resolve`/`write` throws (transient) → no stamp, counted `failed`, retried next run.
 *   The loop never aborts siblings. A stage may additionally opt into a bounded in-stage retry
 *   sweep (#455) by passing `retry` to {@link runEnrichment}: failures its `isRetryable`
 *   predicate accepts are re-`resolve`d for up to `maxRounds` rounds with escalating jittered
 *   backoff, so a transient blip recovers *within the same run* instead of leaving a durable gap
 *   until the next staleness window (the gap a fresh reload has no later window to close).
 *
 * `markAttempted`/`markTerminal` are both optional — a stage declares only the outcomes its
 * `resolve` actually produces. Returning an outcome whose handler is absent is a contract bug,
 * so the runner throws it into the per-item `failed` path (loud, isolated) rather than degrading.
 *
 * Three pipelines deliberately stay OFF this contract (see their headers): `track-deezer`
 * and `track-acousticbrainz` (batch-scoped fetch/write/failure semantics) and
 * `artist-genres` (pure whole-graph Cypher, no candidate loop or stamping).
 */
export interface EnrichmentStage<TItem, TResolved> {
  readonly name: string;
  /** Owns the staleness predicate — selects items still missing data and aged past the window. */
  selectCandidates(driver: Driver): Promise<TItem[]>;
  /**
   * Look the item up against the external source(s). Returns the resolved data; `null` for
   * "queried, no data, but it could appear later" (throttled); or {@link TERMINAL_EMPTY} for
   * "queried, definitively & permanently no data" (terminal). A multi-source fallback lives
   * inside `resolve` — it is a stage-internal concern. `resolve` THROWS on transient failure (it
   * never swallows one and returns `null`), so the runner counts it as `failed` rather than `skipped`.
   */
  resolve(item: TItem): Promise<TResolved | null | typeof TERMINAL_EMPTY>;
  /** Persist the resolved data and stamp `*FetchedAt`. Reached only when `resolve` returned data. */
  write(driver: Driver, item: TItem, resolved: TResolved): Promise<void>;
  /**
   * Stamp `*FetchedAt` without writing data. Reached only when `resolve` returned `null`.
   * Optional — omit it on a stage whose `resolve` never returns `null` (e.g. one that only ever
   * resolves data or {@link TERMINAL_EMPTY}); the runner throws if a `null` arrives without it.
   */
  markAttempted?(driver: Driver, item: TItem): Promise<void>;
  /**
   * Write a PERMANENT terminal marker (plus the `*FetchedAt` stamp) so the candidate query
   * excludes the item for good. Reached only when `resolve` returned {@link TERMINAL_EMPTY}.
   * Required whenever `resolve` can return {@link TERMINAL_EMPTY}; the runner throws otherwise.
   */
  markTerminal?(driver: Driver, item: TItem): Promise<void>;
  /**
   * Optional: a thrown error this stage deems expected → logged at `warn` instead of
   * `error`, keeping it below the prod error alarm threshold (e.g. Genius's Cloudflare 403,
   * issues #195/#243). Absent → every thrown error is logged at `error`.
   */
  isExpectedError?(err: unknown): boolean;
  /** Optional: a short human label for the item, used only in per-item log lines. */
  describeItem?(item: TItem): string;
  /**
   * Optional: items between progress reports — each report is an `onProgress` call plus a
   * `Progress: i/total` info line. Defaults to 25; the slow rate-limited stages (~1 item/s,
   * hours-long runs) declare 10 to keep the log/status freshness their hand-rolled loops had.
   */
  readonly progressEveryItems?: number;
}

const DEFAULT_PROGRESS_EVERY_ITEMS = 25;

/**
 * Opt-in bounded transient-failure retry sweep (#455). When a stage passes this, the runner — after
 * the main pass settles — re-attempts only the items whose failure {@link RetryConfig.isRetryable}
 * accepts, for up to {@link RetryConfig.maxRounds} rounds with an escalating jittered backoff
 * between rounds. The sweep is the fix for the fresh-reload gap: every track is brand-new, so a
 * transient upstream blip has no later staleness window *in the same run* to retry it, and used to
 * harden into a durable coverage gap until an operator re-ran the stage. It is **bounded** so a
 * genuinely-down source doesn't stall the run: it is skipped on SIGTERM and when the transient-
 * failure count exceeds {@link RetryConfig.maxRetryableFraction} of the candidates (the outage
 * backstop — and the *only* one for a timeout outage, which never trips the per-source breaker).
 */
export interface RetryConfig {
  /** Bounded number of sweep rounds. `<= 0` (or an absent `retry`) → no sweep. */
  maxRounds: number;
  /** Which thrown errors are transient and worth re-attempting (e.g. a request timeout). */
  isRetryable: (err: unknown) => boolean;
  /**
   * Nominal backoff base, doubling per round; the actual jittered sleep is `[base/2, base]`
   * (AWS equal jitter, via {@link jitteredBackoffMs}). Defaults to 2000 ms.
   */
  backoffBaseMs?: number;
  /**
   * Skip the whole sweep when transient failures exceed this fraction of the candidate count —
   * a clearly-struggling source isn't worth hammering, the staleness window remains its backstop.
   * Defaults to 0.5.
   */
  maxRetryableFraction?: number;
  /** Injectable sleep for deterministic, timer-free tests; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
}

const DEFAULT_RETRY_BACKOFF_BASE_MS = 2000;
const DEFAULT_RETRY_MAX_FRACTION = 0.5;
/**
 * Absolute floor below which the sweep ALWAYS runs, regardless of the fraction cap. Re-attempting a
 * handful of items is cheap, and on a small collection's fresh reload a high failure *fraction* is
 * noise, not an outage — without this floor a single timed-out track (1 of 1 = 100%) would wrongly
 * skip the sweep and leave the very gap #455 closes. The fraction governs only once failures are
 * numerous enough to risk a long sweep (it dominates at the large-reload scale the cap targets).
 */
const DEFAULT_RETRY_MIN_SWEEP = 25;
/**
 * Ceiling on the sweep's per-round backoff base, mirroring rate-limited-fetch's `DEFAULT_BACKOFF_CEIL_MS`.
 * The base doubles each round (`base × 2^(round-1)`), so without a clamp a large `LYRICS_RETRY_ROUNDS`
 * would grow a single inter-round sleep to hours/days; clamp keeps it bounded regardless of round count.
 */
const DEFAULT_RETRY_BACKOFF_CEIL_MS = 32_000;

/** The settled result of running one item through the contract, before counters are touched. */
type ItemOutcome =
  | { kind: 'enriched' }
  | { kind: 'skipped' }
  | { kind: 'exhausted' }
  | { kind: 'failed'; err: unknown };

/**
 * Drain `items` through `fn` with a bounded shared-index worker pool — the concurrency primitive
 * shared by the main pass and the #455 retry sweep. `min(concurrency, items.length)` workers each
 * claim the next index; the claim (`next < length` then `items[next++]`) is one synchronous step with
 * no await between, so workers never double-draw. The loop ends on the index bound or a `signal`
 * abort — `!signal.aborted` lets a SIGTERM stop the drain between items (#291), each worker finishing
 * its in-flight item. The `undefined` guard is only TypeScript narrowing under
 * `noUncheckedIndexedAccess`: a slot whose value is legitimately `undefined` is skipped, not treated
 * as the end of the drain. At concurrency 1 this is a single serial drainer.
 */
async function drainPool<T>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Drive a {@link EnrichmentStage} over its candidates, owning the per-item isolation and
 * stamp-on-attempt contract so each stage stays a thin declaration of what varies. A failure
 * in one item never aborts the rest, and a transient failure leaves the item unstamped so it
 * retries on the next run. Every `progressEveryItems` settled items it reports progress (an
 * `onProgress` call plus a counters info line); mirrors the original hand-rolled loops'
 * early-fail behaviour.
 *
 * `concurrency` (default `1` → strictly serial, byte-for-byte the original loop) bounds how many
 * items are processed at once via a shared-index worker pool (#247). It is the rate ceiling for
 * a stage whose external lookups should overlap — only `lyrics` opts in today, and only because
 * it is deadlock-immune (one Track per transaction; see the #176 scheduler notes). Counters are
 * mutated synchronously between awaits, so the single-threaded event loop keeps them race-free;
 * under concurrency the progress line is keyed off completion count, not arrival order.
 *
 * `signal` (default the process shutdown signal) makes the run checkpoint-and-exit on SIGTERM (#291):
 * workers stop drawing new items once it aborts, in-flight items finish, and the partial summary is
 * returned (never thrown — a throw would land a reload stage `failed` and break resume). Every write
 * is stamp-on-attempt idempotent, so an aborted run resumes cleanly on the next pass.
 *
 * `retry` (optional, #455) opts the run into a bounded transient-failure retry sweep after the main
 * pass — see {@link RetryConfig}. The sweep reuses the same bounded worker pool but calls the inner
 * `processItem` directly (never `handleItem`), so it does NOT re-report progress or re-collect
 * retryable items; it only re-runs the resolve/write contract and reclassifies the outcome. Recovered
 * items move out of `failed` into their real bucket and increment `summary.recovered`.
 */
export async function runEnrichment<TItem, TResolved>(
  driver: Driver,
  stage: EnrichmentStage<TItem, TResolved>,
  opts?: {
    logger?: Logger;
    onProgress?: ProgressReporter;
    concurrency?: number;
    signal?: AbortSignal;
    retry?: RetryConfig;
  },
): Promise<EnrichmentSummary> {
  const log: Logger = opts?.logger ?? console;
  const onProgress: ProgressReporter = opts?.onProgress ?? NOOP_PROGRESS;
  const signal: AbortSignal = opts?.signal ?? getShutdownSignal();
  const requested = opts?.concurrency;
  const concurrency =
    Number.isInteger(requested) && (requested as number) > 0 ? (requested as number) : 1;
  const retry = opts?.retry;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let exhausted = 0;
  let failed = 0;
  let completed = 0;
  let recovered = 0;
  // Items whose main-pass failure `retry.isRetryable` accepted — the input to the sweep (#455).
  // Stays empty (and the sweep a no-op) for a stage that passes no `retry`.
  const retryableFailures: TItem[] = [];

  log.info(`[${stage.name}] Starting enrichment`);

  let items: TItem[];
  try {
    items = await stage.selectCandidates(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[${stage.name}] Failed to select candidates: ${msg}`);
    return { enriched: 0, skipped: 0, exhausted: 0, failed: 1, durationMs: Date.now() - startTime };
  }

  const total = items.length;
  log.info(`[${stage.name}] Found ${total} candidates`);
  onProgress(0, total);

  // Guard the cadence: `n % 0` is NaN (which would silently disable progress entirely),
  // and a negative or fractional cadence never matches — fall back to the default instead.
  const declared = stage.progressEveryItems;
  const progressEvery =
    declared !== undefined && Number.isInteger(declared) && declared > 0
      ? declared
      : DEFAULT_PROGRESS_EVERY_ITEMS;

  // One item through the full contract, returning the outcome instead of mutating counters — so the
  // retry sweep (#455) can re-run it without touching progress/`completed` or re-collecting failures.
  // It still enforces the stamp-on-attempt contract: a missing markTerminal/markAttempted handler
  // throws into the `failed` outcome (loud, isolated), exactly as before.
  const processItem = async (item: TItem): Promise<ItemOutcome> => {
    try {
      const resolved = await stage.resolve(item);
      if (resolved === TERMINAL_EMPTY) {
        if (stage.markTerminal === undefined) {
          throw new Error(
            'resolve() returned TERMINAL_EMPTY but the stage declares no markTerminal',
          );
        }
        await stage.markTerminal(driver, item);
        return { kind: 'exhausted' };
      } else if (resolved === null) {
        if (stage.markAttempted === undefined) {
          throw new Error('resolve() returned null but the stage declares no markAttempted');
        }
        await stage.markAttempted(driver, item);
        return { kind: 'skipped' };
      } else {
        await stage.write(driver, item, resolved);
        return { kind: 'enriched' };
      }
    } catch (err) {
      return { kind: 'failed', err };
    }
  };

  const logItemFailure = (item: TItem, err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    const label = stage.describeItem?.(item) ?? 'item';
    const line = `[${stage.name}] failed for ${label}: ${msg}`;
    if (stage.isExpectedError?.(err)) {
      log.warn(line);
    } else {
      log.error(line);
    }
  };

  // The main-pass per-item handler: counters + progress + (when `retry` is set) collecting transient
  // failures for the sweep. At concurrency 1 the pool runs these strictly in order, so `completed`
  // tracks the arrival index exactly as the original loop's `i` did. Counters are mutated
  // synchronously after each await, so the single-threaded loop keeps them race-free under concurrency.
  const handleItem = async (item: TItem): Promise<void> => {
    const outcome = await processItem(item);
    if (outcome.kind === 'enriched') {
      enriched++;
    } else if (outcome.kind === 'skipped') {
      skipped++;
    } else if (outcome.kind === 'exhausted') {
      exhausted++;
    } else {
      logItemFailure(item, outcome.err);
      failed++;
      if (retry !== undefined && retry.isRetryable(outcome.err)) {
        retryableFailures.push(item);
      }
    }

    // Reported after the item completes so the counters are coherent with `completed`.
    completed++;
    if (completed % progressEvery === 0) {
      log.info(
        `[${stage.name}] Progress: ${completed}/${total} — enriched=${enriched}, skipped=${skipped}, exhausted=${exhausted}, failed=${failed}`,
      );
      onProgress(completed, total);
    }
  };

  // Main pass: drain every candidate through the bounded pool (see {@link drainPool}).
  await drainPool(items, concurrency, signal, handleItem);

  // Bounded transient-failure retry sweep (#455). Skipped on SIGTERM (a shutting-down run mustn't
  // start new work) and when the transient-failure count exceeds the outage cap (a struggling source
  // isn't worth hammering — the staleness window stays its backstop). Otherwise re-attempt only the
  // collected transient failures for a few rounds with an escalating jittered backoff.
  if (
    !signal.aborted &&
    retry !== undefined &&
    retry.maxRounds > 0 &&
    retryableFailures.length > 0
  ) {
    const maxFraction = retry.maxRetryableFraction ?? DEFAULT_RETRY_MAX_FRACTION;
    const cap = Math.max(DEFAULT_RETRY_MIN_SWEEP, maxFraction * total);
    if (retryableFailures.length > cap) {
      log.warn(
        `[${stage.name}] ${retryableFailures.length} transient failure(s) exceed the retry cap (max(${DEFAULT_RETRY_MIN_SWEEP}, ${maxFraction} × ${total})) — skipping the in-run retry sweep, leaving them for the staleness window`,
      );
    } else {
      const sleep = retry.sleep ?? defaultSleep;
      const jitterOpts = retry.random !== undefined ? { random: retry.random } : {};
      const backoffBaseMs = retry.backoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS;
      let pending = retryableFailures;
      for (
        let round = 1;
        round <= retry.maxRounds && pending.length > 0 && !signal.aborted;
        round++
      ) {
        // The base doubles each round but is clamped so a large maxRounds can't grow a single sleep
        // to hours/days; jitter then halves it to [base/2, base] (AWS equal jitter).
        const cappedBase = Math.min(
          backoffBaseMs * 2 ** (round - 1),
          DEFAULT_RETRY_BACKOFF_CEIL_MS,
        );
        const backoffMs = jitteredBackoffMs(cappedBase, jitterOpts);
        log.info(
          `[${stage.name}] Retry round ${round}/${retry.maxRounds}: re-attempting ${pending.length} transient failure(s) after ${backoffMs}ms`,
        );
        await sleep(backoffMs);
        // A SIGTERM landing during the backoff must not pay another round of re-attempts.
        if (signal.aborted) break;

        const roundItems = pending;
        const stillFailing: TItem[] = [];
        let roundRecovered = 0;
        await drainPool(roundItems, concurrency, signal, async (item) => {
          const outcome = await processItem(item);
          if (outcome.kind === 'failed') {
            if (retry.isRetryable(outcome.err)) {
              stillFailing.push(item);
            } else {
              // Now a non-transient failure — it stays counted `failed`; log the new reason once
              // and drop it from the sweep (re-resolving it further won't change the verdict).
              logItemFailure(item, outcome.err);
            }
          } else {
            failed--;
            recovered++;
            roundRecovered++;
            if (outcome.kind === 'enriched') enriched++;
            else if (outcome.kind === 'skipped') skipped++;
            else exhausted++;
          }
        });
        log.info(
          `[${stage.name}] Retry round ${round}/${retry.maxRounds}: recovered ${roundRecovered}, ${stillFailing.length} still failing`,
        );
        pending = stillFailing;
      }
      // Defensive: counters only ever decrement on a recovery (one per collected failure), so this
      // can't go negative — but clamp so a future change can't surface a negative `failed`.
      failed = Math.max(0, failed);
    }
  }

  const durationMs = Date.now() - startTime;
  const recoveredSuffix = retry !== undefined ? `, recovered=${recovered}` : '';
  if (signal.aborted) {
    // Report the REAL completed count, not total — an aborted run must not read as 100% done, or
    // downstream live progress / shutdown logs would mislead operators (#291).
    onProgress(completed, total);
    log.info(
      `[${stage.name}] Aborted at ${completed}/${total} — enriched=${enriched}, skipped=${skipped}, exhausted=${exhausted}, failed=${failed}${recoveredSuffix}, duration=${durationMs}ms`,
    );
  } else {
    onProgress(total, total);
    log.info(
      `[${stage.name}] Enrichment complete: enriched=${enriched}, skipped=${skipped}, exhausted=${exhausted}, failed=${failed}${recoveredSuffix}, duration=${durationMs}ms`,
    );
  }

  return {
    enriched,
    skipped,
    exhausted,
    failed,
    durationMs,
    ...(retry !== undefined ? { recovered } : {}),
  };
}
