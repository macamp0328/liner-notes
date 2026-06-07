import { describe, it, expect, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { runEnrichment, type EnrichmentStage } from '../../../src/enrichment/run.js';

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

    expect(summary).toMatchObject({ enriched: 0, skipped: 1, failed: 0 });
    expect(markAttempted).toHaveBeenCalledWith(fakeDriver, { id: 1 });
    expect(write).not.toHaveBeenCalled();
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

  it('aggregates enriched/skipped/failed across a mixed batch', async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const resolve = vi
      .fn()
      .mockResolvedValueOnce('a') // enriched
      .mockResolvedValueOnce('b') // enriched
      .mockResolvedValueOnce(null) // skipped
      .mockRejectedValueOnce(new Error('e')); // failed
    const stage = makeStage({
      selectCandidates: vi.fn().mockResolvedValue(items),
      resolve,
    });

    const summary = await runEnrichment(fakeDriver, stage);

    expect(summary).toMatchObject({ enriched: 2, skipped: 1, failed: 1 });
  });

  it('returns a failed summary (does not throw) when selectCandidates fails', async () => {
    const logger = makeMockLogger();
    const stage = makeStage({
      selectCandidates: vi.fn().mockRejectedValue(new Error('neo4j down')),
    });

    const summary = await runEnrichment(fakeDriver, stage, { logger });

    expect(summary).toMatchObject({ enriched: 0, skipped: 0, failed: 1 });
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
});
