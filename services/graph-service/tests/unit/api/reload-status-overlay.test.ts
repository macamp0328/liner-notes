import { describe, it, expect } from 'vitest';
import { overlayLiveProgress, reloadStaleness } from '../../../src/api/admin.js';
import type { PersistedJob } from '../../../src/db/job-repository.js';
import type { LiveStageProgress } from '../../../src/ingestion/reload-progress.js';

function makeJob(overrides: Partial<PersistedJob> = {}): PersistedJob {
  return {
    jobId: 'job-1',
    status: 'running',
    startedAt: '2026-06-05T12:00:00.000Z',
    completedAt: null,
    durationMs: null,
    stages: [
      {
        stage: 'releases',
        ordinal: 0,
        status: 'complete',
        startedAt: null,
        completedAt: null,
        counts: {},
        error: null,
      },
      {
        stage: 'lyrics',
        ordinal: 1,
        status: 'running',
        startedAt: '2026-06-05T12:01:00.000Z',
        completedAt: null,
        counts: {},
        error: null,
      },
    ],
    ...overrides,
  };
}

function makeLive(overrides: Partial<LiveStageProgress> = {}): LiveStageProgress {
  return {
    jobId: 'job-1',
    stage: 'lyrics',
    processed: 25,
    total: 100,
    stageStartedAtMs: 0,
    ...overrides,
  };
}

describe('overlayLiveProgress', () => {
  it('returns null when the job is null', () => {
    expect(overlayLiveProgress(null, makeLive(), 1000)).toBeNull();
  });

  it('overlays processed/total and a linear ETA on the running stage', () => {
    // 25/100 done in 10s → 75 remaining should take ~30s.
    const view = overlayLiveProgress(makeJob(), makeLive({ stageStartedAtMs: 0 }), 10_000);
    const lyrics = view?.stages.find((s) => s.stage === 'lyrics');
    expect(lyrics).toMatchObject({ processed: 25, total: 100, etaMs: 30_000 });
    // Non-running stages are untouched (no overlay fields).
    const releases = view?.stages.find((s) => s.stage === 'releases');
    expect(releases).not.toHaveProperty('processed');
  });

  it('reports a null ETA before any progress (processed === 0)', () => {
    const view = overlayLiveProgress(makeJob(), makeLive({ processed: 0 }), 10_000);
    expect(view?.stages.find((s) => s.stage === 'lyrics')).toMatchObject({
      processed: 0,
      total: 100,
      etaMs: null,
    });
  });

  it('reports a null ETA when the stage is effectively done (processed === total)', () => {
    const view = overlayLiveProgress(makeJob(), makeLive({ processed: 100, total: 100 }), 10_000);
    expect(view?.stages.find((s) => s.stage === 'lyrics')?.etaMs).toBeNull();
  });

  it('does not overlay when the live jobId belongs to a different (stale) job', () => {
    const view = overlayLiveProgress(makeJob(), makeLive({ jobId: 'job-stale' }), 10_000);
    expect(view?.stages.find((s) => s.stage === 'lyrics')).not.toHaveProperty('processed');
  });

  it('does not overlay a non-running job even when live progress exists', () => {
    const view = overlayLiveProgress(makeJob({ status: 'complete' }), makeLive(), 10_000);
    expect(view?.stages.find((s) => s.stage === 'lyrics')).not.toHaveProperty('processed');
  });

  it('returns the job unchanged when there is no live progress', () => {
    const job = makeJob();
    expect(overlayLiveProgress(job, null, 10_000)).toBe(job);
  });

  it('does not overlay when the live stage is not the one marked running', () => {
    // Live says master-data, but the persisted running stage is lyrics → no match.
    const view = overlayLiveProgress(makeJob(), makeLive({ stage: 'master-data' }), 10_000);
    expect(view?.stages.find((s) => s.stage === 'lyrics')).not.toHaveProperty('processed');
  });
});

describe('reloadStaleness', () => {
  const THRESHOLD = 12 * 3_600_000; // 12h

  it('flags a running job past the threshold with no live pod as stale', () => {
    expect(reloadStaleness(makeJob(), false, 50 * 3_600_000, THRESHOLD)).toEqual({
      ageMs: 50 * 3_600_000,
      stale: true,
    });
  });

  it('does not flag a running job while a reload is active (live pod)', () => {
    expect(reloadStaleness(makeJob(), true, 50 * 3_600_000, THRESHOLD)).toEqual({
      ageMs: 50 * 3_600_000,
      stale: false,
    });
  });

  it('does not flag a running job younger than the threshold (still surfaces ageMs)', () => {
    expect(reloadStaleness(makeJob(), false, 60_000, THRESHOLD)).toEqual({
      ageMs: 60_000,
      stale: false,
    });
  });

  it('is not stale for a non-running (terminal) job', () => {
    expect(
      reloadStaleness(makeJob({ status: 'complete' }), false, 50 * 3_600_000, THRESHOLD),
    ).toEqual({ ageMs: null, stale: false });
  });

  it('is not stale for a null job or a null age', () => {
    expect(reloadStaleness(null, false, 50 * 3_600_000, THRESHOLD)).toEqual({
      ageMs: null,
      stale: false,
    });
    expect(reloadStaleness(makeJob(), false, null, THRESHOLD)).toEqual({
      ageMs: null,
      stale: false,
    });
  });
});
