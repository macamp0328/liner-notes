import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { Logger } from '../../../src/ingestion/discogs-client.js';
import {
  runReload,
  buildReloadContext,
  resolveConcurrency,
} from '../../../src/ingestion/orchestrator.js';
import { snapshotEnv } from '../../helpers/env.js';

const stageMocks = vi.hoisted(() => ({
  releasesRun: vi.fn(),
  lyricsRun: vi.fn(),
  masterRun: vi.fn(),
}));

vi.mock('../../../src/ingestion/stages.js', () => ({
  RELOAD_STAGES: [
    { name: 'releases', deps: [], resources: [], run: stageMocks.releasesRun },
    { name: 'lyrics', deps: [], resources: [], run: stageMocks.lyricsRun },
    { name: 'master-data', deps: [], resources: [], run: stageMocks.masterRun },
  ],
}));

const repo = vi.hoisted(() => ({
  createReloadJob: vi.fn(),
  getReloadJob: vi.fn(),
  markStageRunning: vi.fn(),
  markStageComplete: vi.fn(),
  markStageFailed: vi.fn(),
  finishReloadJob: vi.fn(),
}));

vi.mock('../../../src/db/job-repository.js', () => repo);

const progress = vi.hoisted(() => ({
  markReloadActive: vi.fn(),
  markReloadInactive: vi.fn(),
  beginStage: vi.fn(),
  reportStageProgress: vi.fn(),
  clearStage: vi.fn(),
}));

vi.mock('../../../src/ingestion/reload-progress.js', () => progress);

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const driver = {} as Driver;

beforeEach(() => {
  vi.clearAllMocks();
  repo.createReloadJob.mockResolvedValue('job-new');
  repo.markStageRunning.mockResolvedValue(undefined);
  repo.markStageComplete.mockResolvedValue(undefined);
  repo.markStageFailed.mockResolvedValue(undefined);
  repo.finishReloadJob.mockResolvedValue(undefined);
  stageMocks.releasesRun.mockResolvedValue({ releasesProcessed: 2 });
  stageMocks.lyricsRun.mockResolvedValue({ enriched: 5 });
  stageMocks.masterRun.mockResolvedValue({ enriched: 1 });
});

describe('runReload — fresh run', () => {
  it('creates a job and runs every stage in order, finishing complete', async () => {
    const result = await runReload(driver, { username: 'tester', logger: log });

    expect(repo.createReloadJob).toHaveBeenCalledWith(driver, [
      'releases',
      'lyrics',
      'master-data',
    ]);
    expect(repo.getReloadJob).not.toHaveBeenCalled();
    // Each stage marked running then complete with its counts.
    expect(repo.markStageRunning).toHaveBeenCalledTimes(3);
    expect(repo.markStageComplete).toHaveBeenCalledWith(driver, 'job-new', 'releases', {
      releasesProcessed: 2,
    });
    expect(repo.markStageComplete).toHaveBeenCalledWith(driver, 'job-new', 'lyrics', {
      enriched: 5,
    });
    expect(repo.finishReloadJob).toHaveBeenCalledWith(driver, 'job-new', 'complete');
    expect(result).toMatchObject({
      jobId: 'job-new',
      status: 'complete',
      stagesRun: 3,
      stagesSkipped: 0,
      stagesFailed: 0,
    });
  });
});

describe('runReload — live progress wiring', () => {
  it('marks the reload active, begins each run stage, and clears the active flag at the end', async () => {
    await runReload(driver, { username: 'tester', logger: log });

    expect(progress.markReloadActive).toHaveBeenCalledExactlyOnceWith('job-new');
    expect(progress.beginStage).toHaveBeenCalledTimes(3);
    expect(progress.beginStage).toHaveBeenCalledWith('job-new', 'releases');
    expect(progress.clearStage).toHaveBeenCalledTimes(3);
    expect(progress.markReloadInactive).toHaveBeenCalledExactlyOnceWith('job-new');
  });

  it('passes each stage a reporter that forwards to reportStageProgress', async () => {
    await runReload(driver, { username: 'tester', logger: log });

    // The reporter is the second arg the orchestrator hands each stage's run().
    const reporter = stageMocks.releasesRun.mock.calls[0]?.[1] as (p: number, t: number) => void;
    expect(typeof reporter).toBe('function');
    reporter(7, 42);
    expect(progress.reportStageProgress).toHaveBeenCalledWith('job-new', 'releases', 7, 42);
  });

  it('clears the active flag even when a stage throws', async () => {
    stageMocks.lyricsRun.mockRejectedValue(new Error('boom'));

    await runReload(driver, { username: 'tester', logger: log });

    expect(progress.markReloadInactive).toHaveBeenCalledExactlyOnceWith('job-new');
  });
});

describe('runReload — resume', () => {
  it('skips already-complete stages and re-runs from the leftover running stage', async () => {
    repo.getReloadJob.mockResolvedValue({
      jobId: 'job-1',
      status: 'running',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      stages: [
        { stage: 'releases', ordinal: 0, status: 'complete', counts: {}, error: null },
        { stage: 'lyrics', ordinal: 1, status: 'complete', counts: {}, error: null },
        { stage: 'master-data', ordinal: 2, status: 'running', counts: {}, error: null },
      ],
    });

    const result = await runReload(driver, {
      username: 'tester',
      logger: log,
      resumeJobId: 'job-1',
    });

    expect(repo.createReloadJob).not.toHaveBeenCalled();
    // The two complete stages are not re-run.
    expect(stageMocks.releasesRun).not.toHaveBeenCalled();
    expect(stageMocks.lyricsRun).not.toHaveBeenCalled();
    // The interrupted stage re-runs.
    expect(stageMocks.masterRun).toHaveBeenCalledOnce();
    expect(repo.markStageRunning).toHaveBeenCalledExactlyOnceWith(driver, 'job-1', 'master-data');
    expect(repo.finishReloadJob).toHaveBeenCalledWith(driver, 'job-1', 'complete');
    expect(result).toMatchObject({ jobId: 'job-1', stagesRun: 1 });
  });

  it('also skips stages that were skipped on the prior run', async () => {
    repo.getReloadJob.mockResolvedValue({
      jobId: 'job-1',
      status: 'running',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      stages: [
        { stage: 'releases', ordinal: 0, status: 'skipped', counts: {}, error: null },
        { stage: 'lyrics', ordinal: 1, status: 'pending', counts: {}, error: null },
        { stage: 'master-data', ordinal: 2, status: 'pending', counts: {}, error: null },
      ],
    });

    await runReload(driver, { username: 'tester', logger: log, resumeJobId: 'job-1' });

    expect(stageMocks.releasesRun).not.toHaveBeenCalled();
    expect(stageMocks.lyricsRun).toHaveBeenCalledOnce();
    expect(stageMocks.masterRun).toHaveBeenCalledOnce();
  });

  it('starts a fresh job when the resumeJobId no longer exists', async () => {
    repo.getReloadJob.mockResolvedValue(null);

    await runReload(driver, { username: 'tester', logger: log, resumeJobId: 'gone' });

    expect(repo.createReloadJob).toHaveBeenCalledOnce();
    expect(stageMocks.releasesRun).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('runReload — failure isolation', () => {
  it('records a thrown stage as failed but continues, finishing failed', async () => {
    stageMocks.lyricsRun.mockRejectedValue(new Error('LRCLIB down'));

    const result = await runReload(driver, { username: 'tester', logger: log });

    expect(repo.markStageFailed).toHaveBeenCalledWith(driver, 'job-new', 'lyrics', 'LRCLIB down');
    // master-data still runs after lyrics fails.
    expect(stageMocks.masterRun).toHaveBeenCalledOnce();
    expect(repo.finishReloadJob).toHaveBeenCalledWith(driver, 'job-new', 'failed');
    expect(result).toMatchObject({ status: 'failed', stagesRun: 2, stagesFailed: 1 });
  });

  it('does not abort the schedule when recording a failure also throws', async () => {
    stageMocks.masterRun.mockRejectedValue(new Error('stage boom'));
    repo.markStageFailed.mockRejectedValue(new Error('db down'));

    const result = await runReload(driver, { username: 'tester', logger: log });

    // The other stages still complete — a rejected checkpoint write can't wedge the run.
    expect(stageMocks.releasesRun).toHaveBeenCalledOnce();
    expect(stageMocks.lyricsRun).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', stagesFailed: 1 });
  });
});

describe('runReload — skip', () => {
  it('records a null-returning stage as skipped (not failed)', async () => {
    stageMocks.masterRun.mockResolvedValue(null);

    const result = await runReload(driver, { username: 'tester', logger: log });

    expect(repo.markStageComplete).toHaveBeenCalledWith(driver, 'job-new', 'master-data', {}, true);
    expect(repo.finishReloadJob).toHaveBeenCalledWith(driver, 'job-new', 'complete');
    expect(result).toMatchObject({ status: 'complete', stagesRun: 2, stagesSkipped: 1 });
  });
});

describe('runReload — concurrency', () => {
  it('with concurrency 1, runs stages strictly in array (priority) order', async () => {
    const order: string[] = [];
    repo.markStageRunning.mockImplementation((_driver, _jobId, stage: string) => {
      order.push(stage);
      return Promise.resolve();
    });

    const result = await runReload(driver, { username: 'tester', logger: log, concurrency: 1 });

    expect(order).toEqual(['releases', 'lyrics', 'master-data']);
    expect(result).toMatchObject({ status: 'complete', stagesRun: 3 });
  });

  it('runs every stage exactly once and finishes complete under the default cap', async () => {
    const result = await runReload(driver, { username: 'tester', logger: log });

    expect(stageMocks.releasesRun).toHaveBeenCalledOnce();
    expect(stageMocks.lyricsRun).toHaveBeenCalledOnce();
    expect(stageMocks.masterRun).toHaveBeenCalledOnce();
    expect(repo.finishReloadJob).toHaveBeenCalledWith(driver, 'job-new', 'complete');
    expect(result).toMatchObject({ status: 'complete', stagesRun: 3 });
  });
});

describe('resolveConcurrency', () => {
  const env = snapshotEnv(['RELOAD_STAGE_CONCURRENCY']);
  beforeEach(() => env.clear());
  afterAll(() => env.restore());

  it('prefers an explicit option, clamped to [1, total]', () => {
    expect(resolveConcurrency(3, 12)).toBe(3);
    expect(resolveConcurrency(0, 12)).toBe(1); // clamped up
    expect(resolveConcurrency(99, 12)).toBe(12); // clamped to total
  });

  it('reads a valid all-digits env var when no option is given', () => {
    process.env['RELOAD_STAGE_CONCURRENCY'] = '4';
    expect(resolveConcurrency(undefined, 12)).toBe(4);
  });

  it('falls back to the default (2) for a malformed env var, not parseInt of its digits', () => {
    for (const bad of ['2foo', 'foo', '', '  ', '-1', '1.5']) {
      process.env['RELOAD_STAGE_CONCURRENCY'] = bad;
      expect(resolveConcurrency(undefined, 12)).toBe(2);
    }
  });

  it('falls back to the default when the env var is unset', () => {
    expect(resolveConcurrency(undefined, 12)).toBe(2);
  });
});

describe('buildReloadContext', () => {
  it('passes the driver/username through and exposes a slot for every client', () => {
    const ctx = buildReloadContext(driver, 'tester', log);
    expect(ctx.driver).toBe(driver);
    expect(ctx.username).toBe('tester');
    expect(ctx).toHaveProperty('discogs');
    expect(ctx).toHaveProperty('musicbrainz');
    expect(ctx).toHaveProperty('acousticbrainz');
    expect(ctx).toHaveProperty('deezer');
    expect(ctx).toHaveProperty('wikidata');
    expect(ctx).toHaveProperty('viaf');
  });
});
