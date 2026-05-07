import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IngestionStats } from '../../../src/ingestion/job-state.js';

const sampleStats: IngestionStats = {
  nodes: { Release: 10 },
  relationships: { RELEASED_BY: 10 },
  lyricsEnriched: 5,
  lyricsSkipped: 3,
  lyricsFailed: 1,
  errorCount: 0,
  errors: [],
};

describe('job-state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initial state is idle with all nulls', async () => {
    const { getJobState } = await import('../../../src/ingestion/job-state.js');
    const state = getJobState();
    expect(state.status).toBe('idle');
    expect(state.jobId).toBe('');
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.durationMs).toBeNull();
    expect(state.stats).toBeNull();
  });

  it('startJob sets status to running and returns a UUID', async () => {
    const { getJobState, startJob } = await import('../../../src/ingestion/job-state.js');
    const jobId = startJob();
    const state = getJobState();
    expect(state.status).toBe('running');
    expect(state.jobId).toBe(jobId);
    expect(typeof jobId).toBe('string');
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.startedAt).not.toBeNull();
    expect(new Date(state.startedAt!).toISOString()).toBe(state.startedAt);
    expect(state.completedAt).toBeNull();
    expect(state.durationMs).toBeNull();
    expect(state.stats).toBeNull();
  });

  it('completeJob sets status to complete with stats and durationMs', async () => {
    const { getJobState, startJob, completeJob } =
      await import('../../../src/ingestion/job-state.js');
    startJob();
    completeJob(sampleStats);
    const state = getJobState();
    expect(state.status).toBe('complete');
    expect(state.completedAt).not.toBeNull();
    expect(state.durationMs).toBeGreaterThanOrEqual(0);
    expect(state.stats).toEqual(sampleStats);
  });

  it('failJob sets status to failed with error in stats', async () => {
    const { getJobState, startJob, failJob } = await import('../../../src/ingestion/job-state.js');
    startJob();
    failJob('something went wrong');
    const state = getJobState();
    expect(state.status).toBe('failed');
    expect(state.completedAt).not.toBeNull();
    expect(state.durationMs).toBeGreaterThanOrEqual(0);
    expect(state.stats?.errorCount).toBe(1);
    expect(state.stats?.errors).toContain('something went wrong');
  });

  it('startJob resets state for a new run', async () => {
    const { getJobState, startJob, completeJob } =
      await import('../../../src/ingestion/job-state.js');
    const firstId = startJob();
    completeJob(sampleStats);
    const secondId = startJob();
    const state = getJobState();
    expect(state.status).toBe('running');
    expect(state.jobId).toBe(secondId);
    expect(state.jobId).not.toBe(firstId);
    expect(state.stats).toBeNull();
    expect(state.completedAt).toBeNull();
  });

  it('getJobState returns a copy and mutations do not affect internal state', async () => {
    const { getJobState, startJob, completeJob } =
      await import('../../../src/ingestion/job-state.js');
    startJob();
    completeJob(sampleStats);

    // Top-level primitive mutation
    const snap1 = getJobState();
    snap1.status = 'idle';
    expect(getJobState().status).toBe('complete');

    // Nested object mutation — structuredClone ensures these don't bleed through
    const snap2 = getJobState();
    snap2.stats!.nodes['Release'] = 9999;
    snap2.stats!.errors.push('injected');
    const fresh = getJobState();
    expect(fresh.stats!.nodes['Release']).toBe(10);
    expect(fresh.stats!.errors).toHaveLength(0);
  });
});
