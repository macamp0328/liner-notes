import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { initTestDriver } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import {
  createReloadJob,
  markStageComplete,
  markStageRunning,
  finishReloadJob,
  abortReloadJob,
  getReloadJob,
  getReloadJobAgeMs,
} from '../../../src/db/job-repository.js';

/**
 * Exercises the #326 escape-hatch Cypher against a REAL Neo4j. The unit tests only assert query
 * substrings against a mocked session, so the load-bearing semantics — the job flips even with zero
 * running stages, multiple running stages all fail (no row-multiplication miscount), abort no-ops on
 * an already-terminal job (the `status: 'running'` guard), and the server-side age computation — are
 * only proven here. This is an escape hatch run during an incident, so a latent Cypher bug would
 * surface in production at the worst time.
 */
const STAGES = ['releases', 'lyrics', 'verify'];

async function runRaw(driver: Driver, cypher: string): Promise<void> {
  const session = driver.session();
  try {
    await session.run(cypher);
  } finally {
    await session.close();
  }
}

describe('abortReloadJob / getReloadJobAgeMs (real Neo4j)', () => {
  let driver: Driver;

  beforeAll(() => {
    driver = initTestDriver();
  });

  afterEach(async () => {
    await clearGraph(driver);
  });

  afterAll(async () => {
    await clearGraph(driver);
  });

  it('fails a running stage, flips the job, and leaves settled stages untouched', async () => {
    const jobId = await createReloadJob(driver, STAGES);
    await markStageComplete(driver, jobId, 'releases', { releasesProcessed: 3 });
    await markStageRunning(driver, jobId, 'lyrics');

    const abortedStages = await abortReloadJob(driver, jobId);

    expect(abortedStages).toBe(1);
    const job = await getReloadJob(driver, jobId);
    expect(job?.status).toBe('failed');
    expect(job?.completedAt).not.toBeNull();
    expect(typeof job?.durationMs).toBe('number');
    const byName = Object.fromEntries((job?.stages ?? []).map((s) => [s.stage, s]));
    expect(byName['releases']?.status).toBe('complete'); // settled stage untouched
    expect(byName['lyrics']?.status).toBe('failed');
    expect(byName['lyrics']?.error).toBe('Aborted by operator');
    expect(byName['verify']?.status).toBe('pending'); // never-started stage untouched
  });

  it('fails every running stage when several were left mid-flight (no count miscount)', async () => {
    const jobId = await createReloadJob(driver, STAGES);
    await markStageRunning(driver, jobId, 'releases');
    await markStageRunning(driver, jobId, 'lyrics');

    const abortedStages = await abortReloadJob(driver, jobId);

    expect(abortedStages).toBe(2);
    const job = await getReloadJob(driver, jobId);
    const statuses = (job?.stages ?? []).map((s) => s.status);
    expect(statuses.filter((s) => s === 'failed')).toHaveLength(2);
  });

  it('still flips a job with zero running stages and returns 0', async () => {
    const jobId = await createReloadJob(driver, STAGES); // all stages pending, job running

    const abortedStages = await abortReloadJob(driver, jobId);

    expect(abortedStages).toBe(0);
    expect((await getReloadJob(driver, jobId))?.status).toBe('failed');
  });

  it('is a no-op on an already-terminal job (does not resurrect a complete job to failed)', async () => {
    const jobId = await createReloadJob(driver, STAGES);
    await finishReloadJob(driver, jobId, 'complete');

    const abortedStages = await abortReloadJob(driver, jobId);

    expect(abortedStages).toBe(0);
    expect((await getReloadJob(driver, jobId))?.status).toBe('complete');
  });

  it('returns 0 (and does not throw) when the job does not exist', async () => {
    expect(await abortReloadJob(driver, 'no-such-job')).toBe(0);
  });

  it('getReloadJobAgeMs returns a non-negative age for a started job, null when missing', async () => {
    const jobId = await createReloadJob(driver, STAGES);

    const ageMs = await getReloadJobAgeMs(driver, jobId);
    expect(typeof ageMs).toBe('number');
    expect(ageMs).toBeGreaterThanOrEqual(0);

    expect(await getReloadJobAgeMs(driver, 'no-such-job')).toBeNull();
  });

  it('getReloadJobAgeMs returns null when startedAt is absent', async () => {
    await runRaw(
      driver,
      "CREATE (:ReloadJob {jobId: 'no-start', status: 'running', startedAt: null, completedAt: null, durationMs: null})",
    );
    expect(await getReloadJobAgeMs(driver, 'no-start')).toBeNull();
  });
});
