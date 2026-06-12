import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import { getShutdownSignal } from '../lifecycle/shutdown.js';

/**
 * The shared summary every per-item enrichment run returns. Stages that track extra
 * source-specific counters layer them on at their own boundary; these four are the
 * invariant the runner owns.
 */
export interface EnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * A per-item enrichment stage. The stage declares only what varies — candidate
 * selection, the external lookup, and the two writes — while {@link runEnrichment}
 * owns the loop invariants: per-item failure isolation, the stamp-on-attempt contract,
 * progress reporting, and summary aggregation (issue #222).
 *
 * The stamp-on-attempt contract the runner enforces (issue #89):
 * - `resolve` returns data → `write` persists + stamps `*FetchedAt`, counted `enriched`.
 * - `resolve` returns `null` (queried, definitively no data) → `markAttempted` stamps so a
 *   known-empty source is retried at most once per staleness window, counted `skipped`.
 * - `resolve`/`write` throws (transient) → no stamp, counted `failed`, retried next run.
 *   The loop never aborts siblings.
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
   * Look the item up against the external source(s). Returns the resolved data, or `null`
   * for "queried successfully, no data". A multi-source fallback lives inside `resolve` —
   * it is a stage-internal concern. `resolve` THROWS on transient failure (it never swallows
   * one and returns `null`), so the runner counts it as `failed` rather than `skipped`.
   */
  resolve(item: TItem): Promise<TResolved | null>;
  /** Persist the resolved data and stamp `*FetchedAt`. Reached only when `resolve` returned data. */
  write(driver: Driver, item: TItem, resolved: TResolved): Promise<void>;
  /** Stamp `*FetchedAt` without writing data. Reached only when `resolve` returned `null`. */
  markAttempted(driver: Driver, item: TItem): Promise<void>;
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
 */
export async function runEnrichment<TItem, TResolved>(
  driver: Driver,
  stage: EnrichmentStage<TItem, TResolved>,
  opts?: {
    logger?: Logger;
    onProgress?: ProgressReporter;
    concurrency?: number;
    signal?: AbortSignal;
  },
): Promise<EnrichmentSummary> {
  const log: Logger = opts?.logger ?? console;
  const onProgress: ProgressReporter = opts?.onProgress ?? NOOP_PROGRESS;
  const signal: AbortSignal = opts?.signal ?? getShutdownSignal();
  const requested = opts?.concurrency;
  const concurrency =
    Number.isInteger(requested) && (requested as number) > 0 ? (requested as number) : 1;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let completed = 0;

  log.info(`[${stage.name}] Starting enrichment`);

  let items: TItem[];
  try {
    items = await stage.selectCandidates(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[${stage.name}] Failed to select candidates: ${msg}`);
    return { enriched: 0, skipped: 0, failed: 1, durationMs: Date.now() - startTime };
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

  // One item through the full contract. At concurrency 1 the pool runs these strictly in order,
  // so `completed` tracks the arrival index exactly as the original loop's `i` did.
  const handleItem = async (item: TItem): Promise<void> => {
    try {
      const resolved = await stage.resolve(item);
      if (resolved === null) {
        await stage.markAttempted(driver, item);
        skipped++;
      } else {
        await stage.write(driver, item, resolved);
        enriched++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const label = stage.describeItem?.(item) ?? 'item';
      const line = `[${stage.name}] failed for ${label}: ${msg}`;
      if (stage.isExpectedError?.(err)) {
        log.warn(line);
      } else {
        log.error(line);
      }
      failed++;
    }

    // Reported after the item completes so the counters are coherent with `completed`.
    completed++;
    if (completed % progressEvery === 0) {
      log.info(
        `[${stage.name}] Progress: ${completed}/${total} — enriched=${enriched}, skipped=${skipped}, failed=${failed}`,
      );
      onProgress(completed, total);
    }
  };

  // Shared-index worker pool: each worker draws the next item until the list is drained.
  // `min(concurrency, total)` workers — at concurrency 1 this is a single serial drainer. The
  // claim (`next < total` then `items[next++]`) is one synchronous step with no await between, so
  // workers never double-draw. Termination is the index bound, not the value: the `undefined`
  // guard is only TypeScript narrowing under `noUncheckedIndexedAccess` — a stage whose `TItem`
  // legitimately includes `undefined` skips that slot without ending the drain early.
  let next = 0;
  const workerCount = Math.min(concurrency, total);
  const workers = Array.from({ length: workerCount }, async () => {
    // `!signal.aborted` lets a SIGTERM stop the drain between items (#291): each worker finishes its
    // in-flight item, then the bound check ends the loop, leaving the rest for the next run.
    while (next < total && !signal.aborted) {
      const item = items[next++];
      if (item !== undefined) await handleItem(item);
    }
  });
  await Promise.all(workers);

  const durationMs = Date.now() - startTime;
  if (signal.aborted) {
    // Report the REAL completed count, not total — an aborted run must not read as 100% done, or
    // downstream live progress / shutdown logs would mislead operators (#291).
    onProgress(completed, total);
    log.info(
      `[${stage.name}] Aborted at ${completed}/${total} — enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
    );
  } else {
    onProgress(total, total);
    log.info(
      `[${stage.name}] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
    );
  }

  return { enriched, skipped, failed, durationMs };
}
