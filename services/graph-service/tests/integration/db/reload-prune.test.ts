import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { initTestDriver } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { snapshotEnv } from '../../helpers/env.js';
import {
  createReloadJob,
  finishReloadJob,
  pruneTerminalReloadJobs,
  findResumableReloadJob,
} from '../../../src/db/job-repository.js';

/**
 * Exercises the #355 keep-last-N prune against a REAL Neo4j. The unit tests only assert query
 * substrings against a mocked session, so the load-bearing semantics — ORDER BY startedAt + SKIP keeps
 * the newest N, the running/resumable job is never a candidate, DETACH DELETE takes the ReloadStage
 * children with the job (no orphans), and a stageless job's null OPTIONAL MATCH still deletes — are
 * only proven here.
 */

/** Seed a ReloadJob with a deterministic `startedAt` (raw Cypher, so ordering never races a clock). */
async function seedJob(
  driver: Driver,
  jobId: string,
  status: 'running' | 'complete' | 'failed',
  startedAt: string,
  stageCount = 2,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `CREATE (j:ReloadJob {jobId: $jobId, status: $status, startedAt: datetime($startedAt),
              completedAt: null, durationMs: null})`,
      { jobId, status, startedAt },
    );
    if (stageCount > 0) {
      await session.run(
        `MATCH (j:ReloadJob {jobId: $jobId})
         UNWIND range(0, $lastOrdinal) AS i
         CREATE (st:ReloadStage {jobId: $jobId, stage: 'stage-' + toString(i), ordinal: i,
                status: 'complete', startedAt: null, completedAt: null, countsJson: null, error: null})
         CREATE (j)-[:HAS_STAGE {ordinal: i}]->(st)`,
        { jobId, lastOrdinal: neo4j.int(stageCount - 1) },
      );
    }
  } finally {
    await session.close();
  }
}

async function setStartedAt(driver: Driver, jobId: string, startedAt: string): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      'MATCH (j:ReloadJob {jobId: $jobId}) SET j.startedAt = datetime($startedAt)',
      { jobId, startedAt },
    );
  } finally {
    await session.close();
  }
}

/** ReloadJob jobIds, newest `startedAt` first — the same order the prune retains. */
async function jobIdsByStartedAtDesc(driver: Driver): Promise<string[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH (j:ReloadJob) RETURN j.jobId AS jobId ORDER BY j.startedAt DESC',
    );
    return result.records.map((r) => r.get('jobId') as string);
  } finally {
    await session.close();
  }
}

async function count(driver: Driver, cypher: string): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(cypher);
    const raw = result.records[0]?.get('n') as { toNumber(): number } | number | null;
    if (raw === null || raw === undefined) return 0;
    return typeof (raw as { toNumber(): number }).toNumber === 'function'
      ? (raw as { toNumber(): number }).toNumber()
      : (raw as number);
  } finally {
    await session.close();
  }
}

const stageCount = (driver: Driver): Promise<number> =>
  count(driver, 'MATCH (s:ReloadStage) RETURN count(s) AS n');

const orphanStageCount = (driver: Driver): Promise<number> =>
  count(
    driver,
    'MATCH (s:ReloadStage) WHERE NOT (:ReloadJob)-[:HAS_STAGE]->(s) RETURN count(s) AS n',
  );

describe('pruneTerminalReloadJobs (real Neo4j)', () => {
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

  it('keeps the newest N terminal jobs and deletes the rest with their stages', async () => {
    await seedJob(driver, 'j1', 'complete', '2026-01-01T00:00:01Z');
    await seedJob(driver, 'j2', 'failed', '2026-01-01T00:00:02Z');
    await seedJob(driver, 'j3', 'complete', '2026-01-01T00:00:03Z');
    await seedJob(driver, 'j4', 'failed', '2026-01-01T00:00:04Z');
    await seedJob(driver, 'j5', 'complete', '2026-01-01T00:00:05Z');

    const deleted = await pruneTerminalReloadJobs(driver, 2);

    expect(deleted).toBe(3);
    expect(await jobIdsByStartedAtDesc(driver)).toEqual(['j5', 'j4']);
    expect(await stageCount(driver)).toBe(4); // 2 surviving jobs × 2 stages
    expect(await orphanStageCount(driver)).toBe(0);
  });

  it('never prunes a running/resumable job, even when it is the oldest', async () => {
    await seedJob(driver, 'running-old', 'running', '2026-01-01T00:00:01Z');
    await seedJob(driver, 'done-1', 'complete', '2026-01-01T00:00:02Z');
    await seedJob(driver, 'done-2', 'failed', '2026-01-01T00:00:03Z');

    const deleted = await pruneTerminalReloadJobs(driver, 1);

    expect(deleted).toBe(1); // only done-1 (oldest terminal); keep=1 retains done-2
    const resumable = await findResumableReloadJob(driver);
    expect(resumable?.jobId).toBe('running-old');
    expect(await jobIdsByStartedAtDesc(driver)).toEqual(['done-2', 'running-old']);
    expect(await orphanStageCount(driver)).toBe(0);
  });

  it('deletes a terminal job that has no stages (null OPTIONAL MATCH)', async () => {
    await seedJob(driver, 'stageless', 'complete', '2026-01-01T00:00:01Z', 0);
    await seedJob(driver, 'keep-me', 'complete', '2026-01-01T00:00:02Z');

    const deleted = await pruneTerminalReloadJobs(driver, 1);

    expect(deleted).toBe(1);
    expect(await jobIdsByStartedAtDesc(driver)).toEqual(['keep-me']);
  });

  it('is a no-op (returns 0) when terminal jobs are within the keep window', async () => {
    await seedJob(driver, 'a', 'complete', '2026-01-01T00:00:01Z');
    await seedJob(driver, 'b', 'failed', '2026-01-01T00:00:02Z');

    expect(await pruneTerminalReloadJobs(driver, 5)).toBe(0);
    expect(await jobIdsByStartedAtDesc(driver)).toEqual(['b', 'a']);
  });

  it('finishReloadJob prunes to RELOAD_JOB_HISTORY_KEEP, leaving only the latest job', async () => {
    const env = snapshotEnv(['RELOAD_JOB_HISTORY_KEEP']);
    process.env['RELOAD_JOB_HISTORY_KEEP'] = '1';
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const jobId = await createReloadJob(driver, ['releases', 'lyrics']);
        await setStartedAt(driver, jobId, `2026-01-01T00:00:0${i + 1}Z`);
        ids.push(jobId);
        await finishReloadJob(driver, jobId, 'complete');
      }

      expect(await jobIdsByStartedAtDesc(driver)).toEqual([ids[2]]);
      expect(await orphanStageCount(driver)).toBe(0);
    } finally {
      env.restore();
    }
  });
});
