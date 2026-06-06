/**
 * In-memory live-progress mirror for the one orchestrated reload that can be running at a
 * time (issue #179). The persisted `ReloadJob`/`ReloadStage` state in Neo4j is the source of
 * truth for status and resume; this module holds only the *ephemeral* per-stage position
 * (processed/total) and an "is a reload active" flag, so the `/reload/status` overlay and the
 * `/stats` cache gate can read live progress with zero added Neo4j load.
 *
 * Under the #176 bounded-concurrency scheduler several stages run at once, so progress is tracked
 * per stage (keyed by stage name) rather than in a single slot — a settling stage clears only its
 * own entry and never wipes a still-running sibling's. `getLiveProgress` surfaces the bottleneck
 * (earliest-started) running stage for the single-stage overlay.
 *
 * Why in-memory is correct: the reload runs in-process (single k3s pod), and `POST /reload`'s
 * 409 guard + cold-start resume guarantee a single active job. Progress is cosmetic — on a
 * crash the persisted stage *status* already marks the mid-run stage, and the resumed stage
 * re-reports as its loop runs. Persisting per-batch counters would add the very Neo4j writes
 * the issue says to avoid.
 */

/** Live position of a stage currently executing within the active reload. */
export interface LiveStageProgress {
  jobId: string;
  stage: string;
  processed: number;
  total: number;
  /** `Date.now()` captured when the stage began — the single clock used for ETA. */
  stageStartedAtMs: number;
}

let activeJobId: string | null = null;
/** Stage name → its live position. Holds one entry per concurrently-running stage. */
const live = new Map<string, LiveStageProgress>();

/** Mark a reload job active so the /stats cache and snapshot timer tighten their cadence. */
export function markReloadActive(jobId: string): void {
  activeJobId = jobId;
}

/**
 * Mark the reload inactive. Only clears when `jobId` matches the active job, so a late
 * `finally` from a superseded run can't wipe a newer reload's active flag. Also drops any
 * live stage progress.
 */
export function markReloadInactive(jobId: string): void {
  if (activeJobId === jobId) {
    activeJobId = null;
    live.clear();
  }
}

/** Zero-I/O check used by the public /stats handler and the snapshot timer. */
export function isReloadActive(): boolean {
  return activeJobId !== null;
}

/** Begin tracking a stage: resets its counters to 0 and stamps the ETA clock. */
export function beginStage(jobId: string, stage: string): void {
  live.set(stage, { jobId, stage, processed: 0, total: 0, stageStartedAtMs: Date.now() });
}

/**
 * Update a stage's counters. No-op when no live entry matches `jobId`/`stage`, which guards
 * against a stray callback firing after the orchestrator has cleared that stage.
 */
export function reportStageProgress(
  jobId: string,
  stage: string,
  processed: number,
  total: number,
): void {
  const entry = live.get(stage);
  if (entry === undefined || entry.jobId !== jobId) return;
  entry.processed = processed;
  entry.total = total;
}

/**
 * Snapshot of the bottleneck (earliest-started) running stage for the /reload/status overlay,
 * or null when none is running. Under concurrency this is the longest-running stage — the most
 * useful single position/ETA to surface.
 */
export function getLiveProgress(): LiveStageProgress | null {
  let earliest: LiveStageProgress | null = null;
  for (const entry of live.values()) {
    if (earliest === null || entry.stageStartedAtMs < earliest.stageStartedAtMs) {
      earliest = entry;
    }
  }
  return earliest;
}

/**
 * Drop one stage's live progress once it settles. Keyed by `jobId`/`stage` so a finishing stage
 * clears only its own entry — under concurrency it must not wipe a still-running sibling's.
 */
export function clearStage(jobId: string, stage: string): void {
  const entry = live.get(stage);
  if (entry !== undefined && entry.jobId === jobId) live.delete(stage);
}

/** Test-only: reset module state so the singleton doesn't leak across vitest files. */
export function __resetReloadProgress(): void {
  activeJobId = null;
  live.clear();
}
