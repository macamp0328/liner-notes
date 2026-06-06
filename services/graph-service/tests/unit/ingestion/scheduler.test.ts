import { describe, it, expect, vi } from 'vitest';
import { scheduleStages, validateStageGraph } from '../../../src/ingestion/scheduler.js';
import type { SchedulableStage } from '../../../src/ingestion/scheduler.js';
import type { Logger } from '../../../src/ingestion/discogs-client.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** A promise whose resolution the test drives explicitly. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flush pending microtasks + the chained `.then` launches by yielding a macrotask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stage(name: string, deps: string[] = [], resources: string[] = []): SchedulableStage {
  return { name, deps, resources };
}

/**
 * Build a `run` that records launch order and blocks each stage on a per-stage deferred the test
 * controls — lets us observe exactly what is in flight at each step.
 */
function harness(stages: SchedulableStage[]) {
  const launched: string[] = [];
  const gates = new Map(stages.map((s) => [s.name, deferred()]));
  const run = vi.fn(async (s: SchedulableStage) => {
    launched.push(s.name);
    await gates.get(s.name)!.promise;
  });
  return { launched, gates, run };
}

describe('scheduleStages — concurrency cap', () => {
  it('never runs more than `concurrency` stages at once and backfills as slots free', async () => {
    const stages = ['a', 'b', 'c', 'd', 'e'].map((n) => stage(n));
    const { launched, gates, run } = harness(stages);

    const done = scheduleStages({ stages, concurrency: 2, run, log });
    await flush();
    expect(launched).toEqual(['a', 'b']); // cap respected, priority order

    gates.get('a')!.resolve();
    await flush();
    expect(launched).toEqual(['a', 'b', 'c']); // one frees → next launches

    gates.get('b')!.resolve();
    gates.get('c')!.resolve();
    await flush();
    expect(launched).toEqual(['a', 'b', 'c', 'd', 'e']);

    gates.get('d')!.resolve();
    gates.get('e')!.resolve();
    await expect(done).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(5);
  });
});

describe('scheduleStages — dependencies', () => {
  it('does not launch a stage until all its deps have settled', async () => {
    const stages = [stage('a'), stage('b', ['a'])];
    const { launched, gates, run } = harness(stages);

    const done = scheduleStages({ stages, concurrency: 2, run, log });
    await flush();
    expect(launched).toEqual(['a']); // b waits on a

    gates.get('a')!.resolve();
    await flush();
    expect(launched).toEqual(['a', 'b']);

    gates.get('b')!.resolve();
    await expect(done).resolves.toBeUndefined();
  });

  it('treats a dep satisfied by a failed/skipped settle as satisfied', async () => {
    const stages = [stage('boom'), stage('dependent', ['boom'])];
    const launched: string[] = [];
    const run = vi.fn(async (s: SchedulableStage) => {
      launched.push(s.name);
      if (s.name === 'boom') throw new Error('kaboom'); // settles via the scheduler's catch
    });

    await scheduleStages({ stages, concurrency: 2, run, log });
    expect(launched).toContain('boom');
    expect(launched).toContain('dependent'); // ran even though its dep threw
  });
});

describe('scheduleStages — resource exclusion', () => {
  it('serialises stages sharing a resource while a tagless stage runs alongside', async () => {
    const stages = [stage('x', [], ['r']), stage('y', [], ['r']), stage('z', [], [])];
    const { launched, gates, run } = harness(stages);

    const done = scheduleStages({ stages, concurrency: 3, run, log });
    await flush();
    // x grabs `r`; y is blocked on `r`; z holds nothing so it runs concurrently.
    expect(launched).toEqual(['x', 'z']);

    gates.get('x')!.resolve();
    await flush();
    expect(launched).toEqual(['x', 'z', 'y']); // y launches once x releases `r`

    gates.get('y')!.resolve();
    gates.get('z')!.resolve();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('scheduleStages — failure isolation', () => {
  it('a throwing run settles and does not block an independent stage', async () => {
    const stages = [stage('boom'), stage('ok')];
    const launched: string[] = [];
    const run = vi.fn(async (s: SchedulableStage) => {
      launched.push(s.name);
      if (s.name === 'boom') throw new Error('kaboom');
    });

    await expect(scheduleStages({ stages, concurrency: 2, run, log })).resolves.toBeUndefined();
    expect(launched).toContain('ok');
    expect(launched).toContain('boom');
  });
});

describe('scheduleStages — alreadyDone', () => {
  it('skips already-settled stages and treats them as satisfied deps', async () => {
    const stages = [stage('a'), stage('b', ['a'])];
    const { launched, gates, run } = harness(stages);

    const done = scheduleStages({
      stages,
      concurrency: 2,
      alreadyDone: new Set(['a']),
      run,
      log,
    });
    await flush();
    expect(launched).toEqual(['b']); // a skipped; b runs because dep a is already done

    gates.get('b')!.resolve();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('scheduleStages — priority under contention', () => {
  it('with concurrency 1, launches strictly in array order', async () => {
    const stages = [stage('a'), stage('b'), stage('c')];
    const { launched, gates, run } = harness(stages);

    const done = scheduleStages({ stages, concurrency: 1, run, log });
    await flush();
    expect(launched).toEqual(['a']);

    gates.get('a')!.resolve();
    await flush();
    expect(launched).toEqual(['a', 'b']);

    gates.get('b')!.resolve();
    await flush();
    expect(launched).toEqual(['a', 'b', 'c']);

    gates.get('c')!.resolve();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('scheduleStages — stuck guard', () => {
  it('logs and returns instead of hanging when a stage depends on a missing stage', async () => {
    const stages = [stage('a', ['ghost'])];
    const stuckLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const run = vi.fn(async () => {});

    await expect(
      scheduleStages({ stages, concurrency: 2, run, log: stuckLog }),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(stuckLog.error).toHaveBeenCalledWith(expect.stringContaining('stuck'));
  });
});

describe('validateStageGraph', () => {
  it('accepts a valid DAG', () => {
    const stages = [stage('a'), stage('b', ['a']), stage('c', ['a', 'b'])];
    expect(() => validateStageGraph(stages)).not.toThrow();
  });

  it('rejects a dep on an unknown stage', () => {
    expect(() => validateStageGraph([stage('a', ['ghost'])])).toThrow(/unknown stage "ghost"/);
  });

  it('rejects a self-dependency', () => {
    expect(() => validateStageGraph([stage('a', ['a'])])).toThrow(/depends on itself/);
  });

  it('rejects a dependency cycle', () => {
    const stages = [stage('a', ['b']), stage('b', ['a'])];
    expect(() => validateStageGraph(stages)).toThrow(/cycle/);
  });
});
