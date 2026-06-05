import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { Logger } from '../../../src/ingestion/discogs-client.js';
import { runReload, buildReloadContext } from '../../../src/ingestion/orchestrator.js';

const stageMocks = vi.hoisted(() => ({
  releasesRun: vi.fn(),
  lyricsRun: vi.fn(),
  masterRun: vi.fn(),
}));

vi.mock('../../../src/ingestion/stages.js', () => ({
  RELOAD_STAGES: [
    { name: 'releases', run: stageMocks.releasesRun },
    { name: 'lyrics', run: stageMocks.lyricsRun },
    { name: 'master-data', run: stageMocks.masterRun },
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
