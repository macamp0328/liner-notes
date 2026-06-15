import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import {
  runEnrichment,
  TERMINAL_EMPTY,
  type EnrichmentStage,
} from '../../../src/enrichment/run.js';
import { __resetShutdown } from '../../../src/lifecycle/shutdown.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

interface Item {
  id: number;
}

/**
 * Build a fake per-item stage. Defaults resolve everything to `null` (skip); pass
 * overrides — including pre-made `vi.fn()` mocks — to drive a specific scenario and to
 * assert against the captured mock.
 */
function makeStage(
  overrides: Partial<EnrichmentStage<Item, string>> = {},
): EnrichmentStage<Item, string> {
  return {
    name: 'fake',
    selectCandidates: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    markAttempted: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — the stamp-on-attempt contract (issue #222)
// ---------------------------------------------------------------------------
describe('runEnrichment', () => {
  it('returns zero counts and never resolves when there are no candidates', async () => {
    const stage = makeStage();

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, failed: 0 });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(stage.resolve).not.toHaveBeenCalled();
  });

  it('writes and counts enriched when resolve returns data', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue('lyrics'),
      write,
      markAttempted,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 1, skipped: 0, failed: 0 });
    expect(write).toHaveBeenCalledWith(fakeDriver, { id: 1 }, 'lyrics');
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it('stamps and counts skipped when resolve returns null', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue(null),
      write,
      markAttempted,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 0, skipped: 1, exhausted: 0, failed: 0 });
    expect(markAttempted).toHaveBeenCalledWith(fakeDriver, { id: 1 });
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the terminal marker and counts exhausted when resolve returns TERMINAL_EMPTY', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const markTerminal = vi.fn().mockResolvedValue(undefined);
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue(TERMINAL_EMPTY),
      write,
      markAttempted,
      markTerminal,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, exhausted: 1, failed: 0 });
    expect(markTerminal).toHaveBeenCalledWith(fakeDriver, { id: 1 });
    expect(markAttempted).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('throws into failed (no silent throttle) when TERMINAL_EMPTY without markTerminal', async () => {
    const logger = makeMockLogger();
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue(TERMINAL_EMPTY),
      markAttempted,
      // no markTerminal declared → the runner must throw, not fall back to markAttempted
    });

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, exhausted: 0, failed: 1 });
    expect(markAttempted).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no markTerminal'));
  });

  it('throws into failed when resolve returns null without markAttempted', async () => {
    const logger = makeMockLogger();
    // Built inline (not via makeStage) so `markAttempted` is genuinely absent — under
    // exactOptionalPropertyTypes an explicit `markAttempted: undefined` is not assignable.
    const stage: EnrichmentStage<Item, string> = {
      name: 'fake',
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
    };

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, exhausted: 0, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no markAttempted'));
  });

  it('counts failed exactly once and does not stamp when resolve throws (double-count guard)', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockRejectedValue(new Error('boom')),
      write,
      markAttempted,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, failed: 1 });
    expect(write).not.toHaveBeenCalled();
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it('counts failed and does not fall back to markAttempted when write throws', async () => {
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue('data'),
      write: vi.fn().mockRejectedValue(new Error('db down')),
      markAttempted,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, failed: 1 });
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it('isolates a per-item failure — siblings still resolve and stamp', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const write = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce('data') // id 1 → write
      .mockRejectedValueOnce(new Error('x')) // id 2 → failed
      .mockResolvedValueOnce(null); // id 3 → markAttempted
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
      write,
      markAttempted,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 1, skipped: 1, failed: 1 });
    expect(write).toHaveBeenCalledWith(fakeDriver, { id: 1 }, 'data');
    expect(markAttempted).toHaveBeenCalledWith(fakeDriver, { id: 3 });
  });

  it('aggregates enriched/skipped/exhausted/failed across a mixed batch', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const markTerminal = vi.fn().mockResolvedValue(undefined);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce('a') // enriched
      .mockResolvedValueOnce('b') // enriched
      .mockResolvedValueOnce(null) // skipped
      .mockResolvedValueOnce(TERMINAL_EMPTY) // exhausted
      .mockRejectedValueOnce(new Error('e')); // failed
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
      markTerminal,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 2, skipped: 1, exhausted: 1, failed: 1 });
    expect(markTerminal).toHaveBeenCalledWith(fakeDriver, { id: 4 });
  });

  it('returns a failed summary (does not throw) when selectCandidates fails', async () => {
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockRejectedValue(new Error('neo4j down')),
    });

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, exhausted: 0, failed: 1 });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(stage.resolve).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs an expected error at warn (not error) and uses describeItem in the line', async () => {
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockRejectedValue(new Error('expected blip')),
      isExpectedError: () => true,
      describeItem: (item) => `item#${item.id}`,
    });

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expected blip'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('item#1'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs at error with a generic label when the stage declares no isExpectedError/describeItem', async () => {
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockRejectedValue(new Error('unexpected')),
      // no isExpectedError, no describeItem → optional-chaining short-circuits
    });

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary.failed).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unexpected'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed for item'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error thrown value', async () => {
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockRejectedValue('plain string failure'),
    });

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary.failed).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('plain string failure'));
  });

  it('uses console + NOOP defaults when called without opts', async () => {
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue('data'),
    });

    // No opts argument — exercises the `?? console` / `?? NOOP_PROGRESS` fallbacks.
    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary.enriched).toBe(1);
  });

  it('reports onProgress (0,n) first and (n,n) last for a single item', async () => {
    const onProgress = vi.fn();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
      resolve: vi.fn().mockResolvedValue('x'),
    });

    await runEnrichment(fakeDriver, stage, { onProgress });

    expect(onProgress).toHaveBeenNthCalledWith(1, 0, 1);
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
  });

  it('reports progress mid-loop for batches larger than 25 items', async () => {
    const items = Array.from({ length: 26 }, (_, k) => ({ id: k }));
    const onProgress = vi.fn();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve: vi.fn().mockResolvedValue(null), // all skipped — fast
    });

    const summary = await runEnrichment(fakeDriver, stage, { onProgress });

    expect(summary.skipped).toBe(26);
    expect(onProgress).toHaveBeenCalledWith(0, 26);
    expect(onProgress).toHaveBeenCalledWith(25, 26); // i % 25 === 0 at i = 25
    expect(onProgress).toHaveBeenLastCalledWith(26, 26);
  });

  it('honors a stage-declared progressEveryItems cadence', async () => {
    const items = Array.from({ length: 20 }, (_, k) => ({ id: k }));
    const onProgress = vi.fn();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve: vi.fn().mockResolvedValue('x'),
      progressEveryItems: 10,
    });

    await runEnrichment(fakeDriver, stage, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(10, 20);
    expect(onProgress).toHaveBeenCalledWith(20, 20);
    expect(onProgress).toHaveBeenLastCalledWith(20, 20);
  });

  it('logs a mid-loop progress line whose counters reflect the completed items', async () => {
    const items = Array.from({ length: 10 }, (_, k) => ({ id: k }));
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      // 8 enriched, 1 skipped (id 3), 1 failed (id 7)
      resolve: vi.fn().mockImplementation((item: Item) => {
        if (item.id === 3) return Promise.resolve(null);
        if (item.id === 7) return Promise.reject(new Error('boom'));
        return Promise.resolve('x');
      }),
      progressEveryItems: 10,
    });

    await runEnrichment(fakeDriver, stage, { logger });

    expect(logger.info).toHaveBeenCalledWith(
      '[fake] Progress: 10/10 — enriched=8, skipped=1, exhausted=0, failed=1',
    );
  });

  it('falls back to the default cadence when progressEveryItems is invalid', async () => {
    // `i % 0` is NaN — an accidental 0 must not silently disable progress reporting.
    const items = Array.from({ length: 25 }, (_, k) => ({ id: k }));
    const onProgress = vi.fn();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve: vi.fn().mockResolvedValue(null),
      progressEveryItems: 0,
    });

    await runEnrichment(fakeDriver, stage, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(25, 25); // default 25 cadence applied
  });

  it('emits no mid-loop progress log below the default 25-item cadence', async () => {
    const items = Array.from({ length: 24 }, (_, k) => ({ id: k }));
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve: vi.fn().mockResolvedValue(null),
    });

    await runEnrichment(fakeDriver, stage, { logger });

    const progressLines = logger.info.mock.calls.filter(([msg]) =>
      String(msg).includes('Progress:'),
    );
    expect(progressLines).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Concurrency (#247) — opt-in worker pool
  // -------------------------------------------------------------------------
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('never runs more than `concurrency` resolves in flight at once', async () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ id: k }));
    let inFlight = 0;
    let peak = 0;
    const resolve = vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(); // hold the slot open so siblings can pile up if the cap is broken
      inFlight--;
      return 'x';
    });
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
    });

    const summary = await runEnrichment(fakeDriver, stage, { concurrency: 4 });

    expect(summary.enriched).toBe(12);
    expect(peak).toBe(4);
  });

  it('preserves the stamp-on-attempt contract and final totals under concurrency', async () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ id: k }));
    const write = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const markTerminal = vi.fn().mockResolvedValue(undefined);
    // id % 4 === 0 → enriched, === 1 → skipped (null), === 2 → failed (throw), === 3 → exhausted
    const resolve = vi.fn().mockImplementation(async (item: Item) => {
      await tick();
      if (item.id % 4 === 1) return null;
      if (item.id % 4 === 2) throw new Error('boom');
      if (item.id % 4 === 3) return TERMINAL_EMPTY;
      return 'data';
    });
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
      write,
      markAttempted,
      markTerminal,
    });

    const summary = await runEnrichment(fakeDriver, stage, { concurrency: 5 });

    expect(summary).toMatchObject({ enriched: 3, skipped: 3, exhausted: 3, failed: 3 });
    expect(write).toHaveBeenCalledTimes(3);
    expect(markAttempted).toHaveBeenCalledTimes(3);
    expect(markTerminal).toHaveBeenCalledTimes(3);
  });

  it('processes every item exactly once and ends progress at (total,total) under concurrency', async () => {
    const items = Array.from({ length: 7 }, (_, k) => ({ id: k }));
    const seen = new Set<number>();
    const onProgress = vi.fn();
    const resolve = vi.fn().mockImplementation(async (item: Item) => {
      await tick();
      seen.add(item.id);
      return 'x';
    });
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
    });

    const summary = await runEnrichment(fakeDriver, stage, { concurrency: 3, onProgress });

    expect(summary.enriched).toBe(7);
    expect(seen.size).toBe(7); // each item handled once, none dropped or doubled
    expect(resolve).toHaveBeenCalledTimes(7);
    expect(onProgress).toHaveBeenCalledWith(0, 7);
    expect(onProgress).toHaveBeenLastCalledWith(7, 7);
  });

  it('treats an invalid concurrency as serial (1)', async () => {
    const items = Array.from({ length: 5 }, (_, k) => ({ id: k }));
    let inFlight = 0;
    let peak = 0;
    const resolve = vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return 'x';
    });
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
    });

    // 0 is not a valid worker count — must fall back to strictly serial.
    await runEnrichment(fakeDriver, stage, { concurrency: 0 });

    expect(peak).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cooperative shutdown abort (#291)
  // -------------------------------------------------------------------------
  describe('shutdown abort', () => {
    afterEach(() => __resetShutdown());

    it('processes no items when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const items = Array.from({ length: 5 }, (_, k) => ({ id: k }));
      const resolve = vi.fn().mockResolvedValue('x');
      const stage = makeStage({
        selectCandidates: vi.fn().mockResolvedValue(items),
        resolve,
      });

      const summary = await runEnrichment(fakeDriver, stage, { signal: controller.signal });

      expect(resolve).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ enriched: 0, skipped: 0, failed: 0 });
    });

    it('stops drawing new items after a mid-run abort and returns partial counts (no throw)', async () => {
      const controller = new AbortController();
      const items = Array.from({ length: 5 }, (_, k) => ({ id: k }));
      let calls = 0;
      const resolve = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 2) controller.abort();
        return 'x';
      });
      const onProgress = vi.fn();
      const stage = makeStage({
        selectCandidates: vi.fn().mockResolvedValue(items),
        resolve,
      });

      // Serial pool: after the 2nd item aborts the controller, the `!signal.aborted` guard ends the
      // drain before drawing the 3rd — the rest are left for the next (resumed) run.
      const summary = await runEnrichment(fakeDriver, stage, {
        signal: controller.signal,
        concurrency: 1,
        onProgress,
      });

      expect(resolve).toHaveBeenCalledTimes(2);
      expect(summary.enriched).toBe(2);
      // Honest final progress: reflects the 2 completed, not 5/5 (#291).
      expect(onProgress).toHaveBeenLastCalledWith(2, 5);
    });

    it('logs a checkpoint line when aborted', async () => {
      const logger = makeMockLogger();
      const controller = new AbortController();
      controller.abort();
      const stage = makeStage({
        selectCandidates: vi.fn().mockResolvedValue([{ id: 1 }]),
        resolve: vi.fn().mockResolvedValue('x'),
      });

      const summary = await runEnrichment(fakeDriver, stage, {
        signal: controller.signal,
        logger,
      });

      expect(summary.enriched).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Aborted at 0/1'));
    });
  });
});
