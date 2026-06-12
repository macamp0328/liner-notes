import { describe, it, expect } from 'vitest';
import { summarizeRunningJobs } from '../../../src/lifecycle/summarize-running-jobs.js';
import type { RunningJobsInput } from '../../../src/lifecycle/summarize-running-jobs.js';
import type { LiveStageProgress } from '../../../src/ingestion/reload-progress.js';

const idleInput: RunningJobsInput = {
  ingestStatus: 'idle',
  reloadActive: false,
  reloadProgress: null,
  runningPipelines: [],
};

describe('summarizeRunningJobs (#291)', () => {
  it('returns null when nothing is running', () => {
    expect(summarizeRunningJobs(idleInput)).toBeNull();
  });

  it('reports a running ingest job', () => {
    const summary = summarizeRunningJobs({ ...idleInput, ingestStatus: 'running' });

    expect(summary).not.toBeNull();
    expect(summary?.ingestRunning).toBe(true);
    expect(summary?.reload).toBeNull();
    expect(summary?.pipelines).toEqual([]);
  });

  it('reports an active reload with its live position', () => {
    const progress: LiveStageProgress = {
      jobId: 'job-1',
      stage: 'lyrics',
      processed: 42,
      total: 100,
      stageStartedAtMs: 1000,
    };

    const summary = summarizeRunningJobs({
      ...idleInput,
      reloadActive: true,
      reloadProgress: progress,
    });

    expect(summary?.reload).toEqual({
      active: true,
      jobId: 'job-1',
      stage: 'lyrics',
      processed: 42,
      total: 100,
    });
  });

  it('reports an active reload with null/zero fields when no stage progress is live', () => {
    const summary = summarizeRunningJobs({
      ...idleInput,
      reloadActive: true,
      reloadProgress: null,
    });

    expect(summary?.reload).toEqual({
      active: true,
      jobId: null,
      stage: null,
      processed: 0,
      total: 0,
    });
  });

  it('passes through running pipeline names', () => {
    const summary = summarizeRunningJobs({
      ...idleInput,
      runningPipelines: ['lyrics', 'master-data'],
    });

    expect(summary?.pipelines).toEqual(['lyrics', 'master-data']);
  });
});
