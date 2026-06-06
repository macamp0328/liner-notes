import type { Logger } from './discogs-client.js';

/**
 * A unit of work the scheduler can order: a name, its ordering prerequisites, and the named
 * resource lanes it holds for the duration of its run. Two stages sharing any resource never run
 * concurrently; a stage only starts once every dep has reached a terminal state.
 *
 * Generic on purpose — the scheduler knows nothing about Neo4j, reload jobs, or what a resource
 * string means. The reload's `StageDescriptor` satisfies this shape.
 */
export interface SchedulableStage {
  name: string;
  deps: readonly string[];
  resources: readonly string[];
}

export interface ScheduleOptions<T extends SchedulableStage> {
  /** Every stage, in priority order — when several are eligible for one free slot, the earlier wins. */
  stages: readonly T[];
  /** Maximum stages running at once (clamped to at least 1). */
  concurrency: number;
  /** Stage names already settled on a prior run: skipped here, and treated as satisfied deps. */
  alreadyDone?: ReadonlySet<string>;
  /**
   * Run one stage. Should resolve for every outcome (complete/skipped/failed) — the caller records
   * the outcome itself. The scheduler additionally swallows a rejection so a throwing run can never
   * wedge the schedule (failure isolation): the stage still settles and its dependents proceed.
   */
  run: (stage: T) => Promise<void>;
  /** Defaults to `console`. */
  log?: Logger;
}

/**
 * Run stages with bounded concurrency, honouring dependencies and resource exclusion.
 *
 * Each round, every eligible stage that fits is launched in priority (array) order — a stage is
 * eligible when it is not already launched/settled, all its deps are settled, none of its resources
 * is held, and `concurrency` is not yet reached. Resources are acquired synchronously at launch, so
 * two stages sharing a resource can never both launch in the same tick. When a stage settles its
 * resources are released and its dependents may launch.
 *
 * A dep is satisfied by ANY terminal state (complete/skipped/failed), matching the sequential
 * loop's "a skipped/failed stage doesn't block the rest" semantics — the dep is an ordering edge,
 * not a success gate.
 */
export async function scheduleStages<T extends SchedulableStage>(
  options: ScheduleOptions<T>,
): Promise<void> {
  const { stages, run } = options;
  const log: Logger = options.log ?? console;
  const concurrency = Math.max(1, Math.floor(options.concurrency));

  const byName = new Map<string, T>(stages.map((s) => [s.name, s]));
  // Only count names that are actual stages, so a stray `alreadyDone` entry can't skew the loop.
  const settled = new Set<string>([...(options.alreadyDone ?? [])].filter((n) => byName.has(n)));
  const launched = new Set<string>(settled);
  const held = new Set<string>();
  // Each inflight promise resolves to its own stage name, so `Promise.race` tells us who finished.
  const inflight = new Map<string, Promise<string>>();

  while (settled.size < stages.length) {
    for (const stage of stages) {
      if (inflight.size >= concurrency) break;
      if (launched.has(stage.name)) continue;
      if (!stage.deps.every((d) => settled.has(d))) continue;
      if (stage.resources.some((r) => held.has(r))) continue;

      launched.add(stage.name);
      for (const r of stage.resources) held.add(r);
      log.info(`[reload] launching "${stage.name}" (${inflight.size + 1}/${concurrency} running)`);
      inflight.set(
        stage.name,
        // `Promise.resolve().then(run)` also catches a synchronous throw from run().
        Promise.resolve()
          .then(() => run(stage))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`[reload] scheduler: run("${stage.name}") rejected unexpectedly: ${msg}`);
          })
          .then(() => stage.name),
      );
    }

    if (inflight.size === 0) {
      // Nothing running and nothing launchable → an unsatisfiable/cyclic dep. Defensive only:
      // `validateStageGraph` (unit-tested against the real graph) rules this out in practice.
      const stuck = stages.filter((s) => !settled.has(s.name)).map((s) => s.name);
      log.error(`[reload] scheduler stuck — cannot make progress on: ${stuck.join(', ')}`);
      break;
    }

    const finished = await Promise.race(inflight.values());
    inflight.delete(finished);
    const stage = byName.get(finished);
    if (stage) for (const r of stage.resources) held.delete(r);
    settled.add(finished);
  }
}

/**
 * Assert a stage graph is well-formed: every dep names a real stage, no stage depends on itself,
 * and there are no dependency cycles. Throws on the first problem with a descriptive message.
 *
 * Test-only invariant guard — not called at runtime so a hypothetical bad graph can't abort a live
 * reload (the scheduler's stuck guard handles it defensively instead).
 */
export function validateStageGraph<T extends SchedulableStage>(stages: readonly T[]): void {
  const byName = new Map<string, T>(stages.map((s) => [s.name, s]));

  for (const s of stages) {
    for (const d of s.deps) {
      if (d === s.name) throw new Error(`stage "${s.name}" depends on itself`);
      if (!byName.has(d)) throw new Error(`stage "${s.name}" depends on unknown stage "${d}"`);
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string, path: readonly string[]): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`stage dependency cycle: ${[...path, name].join(' → ')}`);
    }
    visiting.add(name);
    for (const d of byName.get(name)?.deps ?? []) visit(d, [...path, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const s of stages) visit(s.name, []);
}
