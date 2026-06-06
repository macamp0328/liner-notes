/**
 * In-memory live-progress mirror for the one orchestrated reload that can be running at a
 * time (issue #179). The persisted `ReloadJob`/`ReloadStage` state in Neo4j is the source of
 * truth for status and resume; this module holds only the *ephemeral* per-stage position
 * (processed/total) and an "is a reload active" flag, so the `/reload/status` overlay and the
 * `/stats` cache gate can read live progress with zero added Neo4j load.
 *
 * Why in-memory is correct: the reload runs in-process (single k3s pod), and `POST /reload`'s
 * 409 guard + cold-start resume guarantee a single active job. Progress is cosmetic — on a
 * crash the persisted stage *status* already marks the mid-run stage, and the resumed stage
 * re-reports as its loop runs. Persisting per-batch counters would add the very Neo4j writes
 * the issue says to avoid.
 */

/** Live position of the stage currently executing within the active reload. */
export interface LiveStageProgress {
  jobId: string;
  stage: string;
  processed: number;
  total: number;
  /** `Date.now()` captured when the stage began — the single clock used for ETA. */
  stageStartedAtMs: number;
}

let activeJobId: string | null = null;
let live: LiveStageProgress | null = null;

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
    live = null;
  }
}

/** Zero-I/O check used by the public /stats handler and the snapshot timer. */
export function isReloadActive(): boolean {
  return activeJobId !== null;
}

/** Begin tracking a stage: resets counters to 0 and stamps the ETA clock. */
export function beginStage(jobId: string, stage: string): void {
  live = { jobId, stage, processed: 0, total: 0, stageStartedAtMs: Date.now() };
}

/**
 * Update the active stage's counters. No-op when `jobId`/`stage` don't match the live stage,
 * which guards against a stray callback firing after the orchestrator has moved on.
 */
export function reportStageProgress(
  jobId: string,
  stage: string,
  processed: number,
  total: number,
): void {
  if (live === null || live.jobId !== jobId || live.stage !== stage) return;
  live.processed = processed;
  live.total = total;
}

/** Snapshot of the live stage for the /reload/status overlay, or null when none is running. */
export function getLiveProgress(): LiveStageProgress | null {
  return live;
}

/** Clear live progress between stages so the overlay reports a position only while one runs. */
export function clearStage(): void {
  live = null;
}

/** Test-only: reset module state so the singleton doesn't leak across vitest files. */
export function __resetReloadProgress(): void {
  activeJobId = null;
  live = null;
}
