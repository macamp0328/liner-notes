/**
 * Process-lifecycle shutdown coordination (issue #291).
 *
 * On SIGTERM/SIGINT the entry point calls {@link requestShutdown}, flipping a single process-wide
 * `AbortSignal` that the long-running background loops poll between items so they checkpoint-and-exit
 * instead of being torn off mid-write when `closeDriver()` runs. The drain registry lets the entry
 * point wait for the detached fire-and-forget jobs (`runReload`, `runIngestion`, standalone enrich)
 * to settle — bounded by a timeout — BEFORE closing the Neo4j driver, eliminating the "driver closed"
 * mid-write throw and the silent in-memory job loss.
 *
 * Module-level singleton with a `__resetShutdown()` test hook, mirroring `reload-progress.ts` /
 * `job-state.ts`. The loops read {@link getShutdownSignal} as their *default* signal, so abort flows
 * all the way down without threading the controller through every `enrichX`/stage signature; tests
 * pass an explicit `AbortController` to exercise a loop in isolation.
 */

let controller = new AbortController();
const pending = new Set<Promise<unknown>>();

/** The process-wide abort signal the background loops poll. Flips once, on the first shutdown. */
export function getShutdownSignal(): AbortSignal {
  return controller.signal;
}

/** Zero-allocation check the loops use between items to decide whether to checkpoint-and-exit. */
export function isShuttingDown(): boolean {
  return controller.signal.aborted;
}

/** Flip the process-wide abort signal. Idempotent — a second SIGTERM is a no-op. */
export function requestShutdown(): void {
  if (!controller.signal.aborted) controller.abort();
}

/**
 * Register a detached background job so shutdown can wait for it; it auto-untracks when it settles.
 * Untracks via `then(del, del)` — handling BOTH settlement paths — rather than `finally`, which
 * would re-raise a rejected `p` as an unhandled rejection. Call sites own their own `.catch`; this
 * wrapper only manages set membership and must never itself surface an error.
 */
export function trackBackgroundJob(p: Promise<unknown>): void {
  pending.add(p);
  const untrack = (): void => {
    pending.delete(p);
  };
  void p.then(untrack, untrack);
}

/**
 * Await every tracked background job, bounded by `timeoutMs`. Resolves `{ drained: true }` once they
 * all settle, or `{ drained: false, pending }` if the budget expires first (the caller then closes
 * anyway — see the entry point). Uses `allSettled`, not `all`, so a rejecting job doesn't skip the
 * wait, and an unref'd timer so the drain budget itself can't keep the event loop alive.
 */
export async function drainBackgroundJobs(
  timeoutMs: number,
): Promise<{ drained: boolean; pending: number }> {
  if (pending.size === 0) return { drained: true, pending: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  timer?.unref();

  const settled = Promise.allSettled([...pending]).then(() => 'drained' as const);
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return { drained: result === 'drained', pending: pending.size };
}

/** Test-only: fresh controller + empty registry so the singleton doesn't leak across vitest files. */
export function __resetShutdown(): void {
  controller = new AbortController();
  pending.clear();
}
