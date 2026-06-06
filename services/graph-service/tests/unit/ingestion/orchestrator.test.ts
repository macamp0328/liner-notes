import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import type { Logger } from '../../../src/ingestion/discogs-client.js';
import {
  runReload,
  buildReloadContext,
  runVerifyGate,
} from '../../../src/ingestion/orchestrator.js';
import type { ReloadStageName } from '../../../src/ingestion/stages.js';

const stageMocks = vi.hoisted(() => ({
  releasesRun: vi.fn(),
  lyricsRun: vi.fn(),
  masterRun: vi.fn(),
}));

// The runReload tests mock RELOAD_STAGES without `verify`, so they never enter the
// verify branch — runVerifyGate is exercised directly below instead.
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

const progress = vi.hoisted(() => ({
  markReloadActive: vi.fn(),
  markReloadInactive: vi.fn(),
  beginStage: vi.fn(),
  reportStageProgress: vi.fn(),
  clearStage: vi.fn(),
}));

vi.mock('../../../src/ingestion/reload-progress.js', () => progress);

// Mocked so runVerifyGate's gate logic (covered by reload-verify.test.ts) and DB
// scan (getStats) are isolated; we assert only the orchestration around them.
const verifyMocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  evaluateCoverage: vi.fn(),
  reportToCounts: vi.fn(),
  formatVerifyFailure: vi.fn(),
}));

vi.mock('../../../src/db/stats-repository.js', () => ({ getStats: verifyMocks.getStats }));
vi.mock('../../../src/ingestion/reload-verify.js', () => ({
  evaluateCoverage: verifyMocks.evaluateCoverage,
  reportToCounts: verifyMocks.reportToCounts,
  formatVerifyFailure: verifyMocks.formatVerifyFailure,
}));

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

describe('runVerifyGate', () => {
  const ran = new Set<ReloadStageName>(['lyrics', 'master-data']);

  beforeEach(() => {
    verifyMocks.getStats.mockResolvedValue({ counts: {}, enrichment: {} });
    verifyMocks.reportToCounts.mockReturnValue({ coverageChecksFailed: 0 });
    verifyMocks.formatVerifyFailure.mockReturnValue('verify gate FAILED — stage [lyrics]');
  });

  it('passes the ran-stage set through to evaluateCoverage and marks verify complete', async () => {
    verifyMocks.evaluateCoverage.mockReturnValue({ pass: true, metrics: [], failingStages: [] });

    const result = await runVerifyGate(driver, 'job-1', ran, log);

    expect(result).toEqual({ passed: true });
    expect(verifyMocks.getStats).toHaveBeenCalledWith(driver);
    expect(verifyMocks.evaluateCoverage).toHaveBeenCalledWith(expect.anything(), ran);
    expect(repo.markStageComplete).toHaveBeenCalledWith(driver, 'job-1', 'verify', {
      coverageChecksFailed: 0,
    });
    expect(repo.markStageFailed).not.toHaveBeenCalled();
  });

  it('fails loud: logs at error level and persists the report alongside the summary', async () => {
    verifyMocks.evaluateCoverage.mockReturnValue({
      pass: false,
      metrics: [],
      failingStages: ['lyrics'],
    });
    verifyMocks.reportToCounts.mockReturnValue({ coverageChecksFailed: 1 });

    const result = await runVerifyGate(driver, 'job-1', ran, log);

    expect(result).toEqual({ passed: false });
    expect(log.error).toHaveBeenCalled();
    expect(repo.markStageFailed).toHaveBeenCalledWith(
      driver,
      'job-1',
      'verify',
      'verify gate FAILED — stage [lyrics]',
      { coverageChecksFailed: 1 },
    );
    expect(repo.markStageComplete).not.toHaveBeenCalled();
  });

  it('marks verify failed if the coverage scan itself errors', async () => {
    verifyMocks.getStats.mockRejectedValue(new Error('neo4j down'));

    const result = await runVerifyGate(driver, 'job-1', ran, log);

    expect(result).toEqual({ passed: false });
    expect(repo.markStageFailed).toHaveBeenCalledWith(
      driver,
      'job-1',
      'verify',
      expect.stringContaining('verify gate errored: neo4j down'),
    );
  });
});
