import type { JobStatus } from '../ingestion/job-state.js';
import type { LiveStageProgress } from '../ingestion/reload-progress.js';

/**
 * The three synchronous, zero-I/O signals the entry point reads at shutdown to describe what
 * background work is mid-flight (issue #291): the legacy `/ingest` job status, the orchestrated
 * reload's active flag + live position, and the per-pipeline running flags.
 */
export interface RunningJobsInput {
  ingestStatus: JobStatus;
  reloadActive: boolean;
  reloadProgress: LiveStageProgress | null;
  runningPipelines: readonly string[];
}

/** The structured payload logged at shutdown when any background work is interrupted. */
export interface RunningJobsSummary {
  ingestRunning: boolean;
  reload: {
    active: boolean;
    jobId: string | null;
    stage: string | null;
    processed: number;
    total: number;
  } | null;
  pipelines: readonly string[];
}

/**
 * Reduce the raw lifecycle signals to a log payload, or `null` when nothing is running. Pure and
 * dependency-injected so it is unit-testable and keeps the coverage-excluded entry point thin: the
 * entry point reads the four singletons and hands them here, then logs the result loudly.
 */
export function summarizeRunningJobs(input: RunningJobsInput): RunningJobsSummary | null {
  const ingestRunning = input.ingestStatus === 'running';
  const reload = input.reloadActive
    ? {
        active: true,
        jobId: input.reloadProgress?.jobId ?? null,
        stage: input.reloadProgress?.stage ?? null,
        processed: input.reloadProgress?.processed ?? 0,
        total: input.reloadProgress?.total ?? 0,
      }
    : null;
  const pipelines = input.runningPipelines;

  if (!ingestRunning && reload === null && pipelines.length === 0) return null;
  return { ingestRunning, reload, pipelines };
}
