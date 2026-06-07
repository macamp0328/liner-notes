import type { Driver } from 'neo4j-driver';
import type { Logger } from '../ingestion/discogs-client.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

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
}

/**
 * Drive a {@link EnrichmentStage} over its candidates, owning the per-item isolation and
 * stamp-on-attempt contract so each stage stays a thin declaration of what varies. A failure
 * in one item never aborts the rest, and a transient failure leaves the item unstamped so it
 * retries on the next run. Mirrors the original hand-rolled lyrics loop's progress cadence and
 * early-fail behaviour.
 */
export async function runEnrichment<TItem, TResolved>(
  driver: Driver,
  stage: EnrichmentStage<TItem, TResolved>,
  opts?: { logger?: Logger; onProgress?: ProgressReporter },
): Promise<EnrichmentSummary> {
  const log: Logger = opts?.logger ?? console;
  const onProgress: ProgressReporter = opts?.onProgress ?? NOOP_PROGRESS;
  const startTime = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

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

  let i = 0;
  for (const item of items) {
    i++;
    if (i % 25 === 0) onProgress(i, total);

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
  }

  onProgress(total, total);
  const durationMs = Date.now() - startTime;
  log.info(
    `[${stage.name}] Enrichment complete: enriched=${enriched}, skipped=${skipped}, failed=${failed}, duration=${durationMs}ms`,
  );

  return { enriched, skipped, failed, durationMs };
}
