import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  createReloadJob,
  markStageRunning,
  markStageComplete,
  markStageFailed,
  finishReloadJob,
  abortReloadJob,
  getReloadJob,
  getReloadJobAgeMs,
  getLatestReloadJob,
  findResumableReloadJob,
  resolveReloadJobHistoryKeep,
  pruneTerminalReloadJobs,
} from '../../../src/db/job-repository.js';
import { snapshotEnv } from '../../helpers/env.js';

vi.mock('neo4j-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('neo4j-driver')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      int: (n: number) => ({ toNumber: () => n, low: n, high: 0 }),
    },
  };
});

function makeMockSession(runResult: unknown = { records: [] }): {
  session: Session;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = vi.fn().mockResolvedValue(runResult);
  const session = {
    run: runSpy,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

function makeRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

function makeNeo4jInt(n: number) {
  return { toNumber: () => n, low: n, high: 0 };
}

// The keep-last-N prune (#355) reads RELOAD_JOB_HISTORY_KEEP; clear it before every test so a value
// set by one case never leaks into another, and restore the real environment when the file is done.
const env = snapshotEnv(['RELOAD_JOB_HISTORY_KEEP']);
beforeEach(() => env.clear());
afterAll(() => env.restore());

// ---------------------------------------------------------------------------
// createReloadJob
// ---------------------------------------------------------------------------
describe('createReloadJob', () => {
  it('creates the job + one pending stage per name and returns a jobId', async () => {
    const { session, runSpy } = makeMockSession();

    const jobId = await createReloadJob(makeMockDriver(session), ['releases', 'lyrics']);

    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);
    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('CREATE (j:ReloadJob');
    expect(query).toContain("status: 'pending'");
    expect(query).toContain('HAS_STAGE');
    expect(params['jobId']).toBe(jobId);
    const stages = params['stages'] as Array<{ name: string; ordinal: { toNumber(): number } }>;
    expect(stages.map((s) => s.name)).toEqual(['releases', 'lyrics']);
    expect(stages.map((s) => s.ordinal.toNumber())).toEqual([0, 1]);
    expect(session.close).toHaveBeenCalled();
  });

  it('closes the session even when the write throws', async () => {
    const runSpy = vi.fn().mockRejectedValue(new Error('write failed'));
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    await expect(createReloadJob(makeMockDriver(session), ['releases'])).rejects.toThrow(
      'write failed',
    );
    expect(session.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// markStageRunning / markStageComplete / markStageFailed
// ---------------------------------------------------------------------------
describe('stage transition writes', () => {
  it('markStageRunning sets running + startedAt and clears error', async () => {
    const { session, runSpy } = makeMockSession();
    await markStageRunning(makeMockDriver(session), 'job-1', 'lyrics');

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("st.status = 'running'");
    expect(query).toContain('st.startedAt = datetime()');
    expect(query).toContain('st.error = null');
    expect(params).toMatchObject({ jobId: 'job-1', stage: 'lyrics' });
  });

  it('markStageComplete stores complete + serialized counts', async () => {
    const { session, runSpy } = makeMockSession();
    await markStageComplete(makeMockDriver(session), 'job-1', 'lyrics', {
      enriched: 5,
      skipped: 1,
    });

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('st.countsJson = $countsJson');
    expect(params['status']).toBe('complete');
    expect(params['countsJson']).toBe('{"enriched":5,"skipped":1}');
  });

  it('markStageComplete serializes an array-valued count (failedReleaseIds, #417)', async () => {
    const { session, runSpy } = makeMockSession();
    await markStageComplete(makeMockDriver(session), 'job-1', 'releases', {
      releasesProcessed: 3,
      releasesFailed: 2,
      failedReleaseIds: [9, 12],
    });

    const params = (runSpy.mock.calls[0] as [string, Record<string, unknown>])[1];
    // The array survives JSON serialization into countsJson — it is not stripped at the persistence layer.
    expect(params['countsJson']).toBe(
      '{"releasesProcessed":3,"releasesFailed":2,"failedReleaseIds":[9,12]}',
    );
  });

  it('markStageComplete with skipped=true records the skipped status', async () => {
    const { session, runSpy } = makeMockSession();
    await markStageComplete(makeMockDriver(session), 'job-1', 'track-deezer', {}, true);

    const params = (runSpy.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(params['status']).toBe('skipped');
    expect(params['countsJson']).toBe('{}');
  });

  it('markStageFailed records the failure and truncates long error messages', async () => {
    const { session, runSpy } = makeMockSession();
    const longError = 'x'.repeat(5000);
    await markStageFailed(makeMockDriver(session), 'job-1', 'lyrics', longError);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("st.status = 'failed'");
    expect((params['error'] as string).length).toBe(1000);
    // No counts passed → countsJson is left untouched.
    expect(query).not.toContain('countsJson');
    expect(params['countsJson']).toBeUndefined();
  });

  it('markStageFailed persists counts alongside the error when given', async () => {
    const { session, runSpy } = makeMockSession();
    await markStageFailed(makeMockDriver(session), 'job-1', 'verify', 'gate failed', {
      coverageChecksFailed: 2,
    });

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("st.status = 'failed'");
    expect(query).toContain('st.countsJson = $countsJson');
    expect(params['countsJson']).toBe(JSON.stringify({ coverageChecksFailed: 2 }));
  });
});

// ---------------------------------------------------------------------------
// finishReloadJob
// ---------------------------------------------------------------------------
describe('finishReloadJob', () => {
  it('sets status and computes durationMs server-side from startedAt', async () => {
    const { session, runSpy } = makeMockSession();
    await finishReloadJob(makeMockDriver(session), 'job-1', 'complete');

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('j.durationMs = datetime().epochMillis - j.startedAt.epochMillis');
    expect(params).toMatchObject({ jobId: 'job-1', status: 'complete' });
  });

  it('triggers a keep-last-N prune after writing the status (#355)', async () => {
    const { session, runSpy } = makeMockSession();
    await finishReloadJob(makeMockDriver(session), 'job-1', 'complete');

    // Second run is the prune; it must follow the status SET, not replace it.
    const pruneQuery = (runSpy.mock.calls[1] as [string])[0];
    expect(pruneQuery).toContain('DETACH DELETE j, s');
    expect(pruneQuery).toContain('count(DISTINCT j) AS deleted');
  });

  it('swallows a prune failure so a recorded-terminal job is never reverted, and warns', async () => {
    const { session, runSpy } = makeMockSession();
    runSpy.mockReset();
    runSpy
      // status SET matched a node (so warnIfUnmatched stays silent), then the prune throws
      .mockResolvedValueOnce({ records: [makeRecord({ matched: makeNeo4jInt(1) })] })
      .mockRejectedValueOnce(new Error('prune boom'));
    const log = { warn: vi.fn() };

    await expect(
      finishReloadJob(makeMockDriver(session), 'job-1', 'complete', log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('pruneTerminalReloadJobs failed'),
    );
  });

  it('swallows a prune failure even when no logger is passed', async () => {
    const { session, runSpy } = makeMockSession();
    runSpy.mockReset();
    runSpy
      .mockResolvedValueOnce({ records: [makeRecord({ matched: makeNeo4jInt(1) })] })
      .mockRejectedValueOnce(new Error('prune boom'));

    await expect(
      finishReloadJob(makeMockDriver(session), 'job-1', 'failed'),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveReloadJobHistoryKeep / pruneTerminalReloadJobs (#355): keep-last-N cleanup of terminal jobs
// ---------------------------------------------------------------------------
describe('resolveReloadJobHistoryKeep', () => {
  it('parses an all-digits env value', () => {
    process.env['RELOAD_JOB_HISTORY_KEEP'] = '25';
    expect(resolveReloadJobHistoryKeep()).toBe(25);
  });

  it('falls back to the default (10) when unset or malformed', () => {
    expect(resolveReloadJobHistoryKeep()).toBe(10); // cleared by beforeEach
    process.env['RELOAD_JOB_HISTORY_KEEP'] = '10foo';
    expect(resolveReloadJobHistoryKeep()).toBe(10);
  });

  it('floors a zero value at 1 so the just-finished job is never pruned', () => {
    process.env['RELOAD_JOB_HISTORY_KEEP'] = '0';
    expect(resolveReloadJobHistoryKeep()).toBe(1);
  });
});

describe('pruneTerminalReloadJobs', () => {
  const deletedRec = (n: number) => ({ records: [makeRecord({ deleted: makeNeo4jInt(n) })] });
  const keepOf = (params: Record<string, unknown>): number =>
    (params['keep'] as { toNumber(): number }).toNumber();

  it('deletes terminal jobs beyond keep (with their stages) and returns the count', async () => {
    const { session, runSpy } = makeMockSession(deletedRec(3));

    const count = await pruneTerminalReloadJobs(makeMockDriver(session), 5);

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("WHERE j.status IN ['complete', 'failed']");
    expect(query).toContain('ORDER BY j.startedAt DESC SKIP $keep');
    expect(query).toContain('OPTIONAL MATCH (j)-[:HAS_STAGE]->(s:ReloadStage)');
    expect(query).toContain('DETACH DELETE j, s');
    expect(query).toContain('count(DISTINCT j) AS deleted');
    expect(keepOf(params)).toBe(5);
    expect(count).toBe(3);
    expect(session.close).toHaveBeenCalled();
  });

  it('returns 0 when no rows come back', async () => {
    const { session } = makeMockSession({ records: [] });
    expect(await pruneTerminalReloadJobs(makeMockDriver(session), 10)).toBe(0);
  });

  it('floors keep at 1 before sending it to SKIP', async () => {
    const { session, runSpy } = makeMockSession(deletedRec(0));
    await pruneTerminalReloadJobs(makeMockDriver(session), 0);
    const params = (runSpy.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(keepOf(params)).toBe(1);
  });

  it('defaults keep from RELOAD_JOB_HISTORY_KEEP when omitted', async () => {
    process.env['RELOAD_JOB_HISTORY_KEEP'] = '4';
    const { session, runSpy } = makeMockSession(deletedRec(0));
    await pruneTerminalReloadJobs(makeMockDriver(session));
    const params = (runSpy.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(keepOf(params)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// zero-match warnings (#290): the MATCH…SET checkpoint writers silently no-op when their target
// node was deleted (e.g. a /reset wipe mid-reload). Each RETURNs count(...) AS matched; when a
// logger is passed and nothing matched, it warns instead of vanishing.
// ---------------------------------------------------------------------------
describe('checkpoint zero-match warnings', () => {
  const matched = (n: number) => ({ records: [makeRecord({ matched: makeNeo4jInt(n) })] });

  it('markStageRunning RETURNs the match count and warns when the stage node is gone', async () => {
    const { session, runSpy } = makeMockSession(matched(0));
    const log = { warn: vi.fn() };
    await markStageRunning(makeMockDriver(session), 'job-1', 'lyrics', log);

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('RETURN count(st) AS matched');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does not warn when a node matched', async () => {
    const { session } = makeMockSession(matched(1));
    const log = { warn: vi.fn() };
    await markStageComplete(makeMockDriver(session), 'job-1', 'lyrics', {}, false, log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('finishReloadJob warns on a zero match', async () => {
    const { session, runSpy } = makeMockSession(matched(0));
    const log = { warn: vi.fn() };
    await finishReloadJob(makeMockDriver(session), 'job-1', 'failed', log);

    const [query] = runSpy.mock.calls[0] as [string];
    expect(query).toContain('RETURN count(j) AS matched');
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('never throws and never warns when no logger is passed, even on a zero match', async () => {
    const { session } = makeMockSession(matched(0));
    await expect(
      markStageFailed(makeMockDriver(session), 'job-1', 'lyrics', 'boom'),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// abortReloadJob (#326): force a stuck job + its running stages terminal
// ---------------------------------------------------------------------------
describe('abortReloadJob', () => {
  const aborted = (matched: number, stages: number) => ({
    records: [makeRecord({ matched: makeNeo4jInt(matched), abortedStages: makeNeo4jInt(stages) })],
  });

  it('marks the job failed, fails its running stages, and returns the stage count', async () => {
    const { session, runSpy } = makeMockSession(aborted(1, 3));

    const count = await abortReloadJob(makeMockDriver(session), 'job-1');

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain("MATCH (j:ReloadJob {jobId: $jobId, status: 'running'})");
    expect(query).toContain("SET j.status = 'failed'");
    expect(query).toContain('j.durationMs = datetime().epochMillis - j.startedAt.epochMillis');
    expect(query).toContain('OPTIONAL MATCH (j)-[:HAS_STAGE]->(st:ReloadStage {status: ');
    expect(query).toContain("st.error = 'Aborted by operator'");
    expect(query).toContain('count(DISTINCT j) AS matched');
    expect(query).toContain('count(st) AS abortedStages');
    expect(params).toMatchObject({ jobId: 'job-1' });
    expect(count).toBe(3);
    expect(session.close).toHaveBeenCalled();
  });

  it('returns 0 when no stage was running', async () => {
    const { session } = makeMockSession(aborted(1, 0));
    const count = await abortReloadJob(makeMockDriver(session), 'job-1');
    expect(count).toBe(0);
  });

  it('warns on a zero job match when a logger is passed', async () => {
    const { session } = makeMockSession(aborted(0, 0));
    const log = { warn: vi.fn() };
    await abortReloadJob(makeMockDriver(session), 'job-1', log);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getReloadJobAgeMs (#326): server-side age for the /reload/status staleness signal
// ---------------------------------------------------------------------------
describe('getReloadJobAgeMs', () => {
  it('computes age server-side and coerces the neo4j integer', async () => {
    const { session, runSpy } = makeMockSession({
      records: [makeRecord({ ageMs: makeNeo4jInt(90000) })],
    });

    const ageMs = await getReloadJobAgeMs(makeMockDriver(session), 'job-1');

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('datetime().epochMillis - j.startedAt.epochMillis');
    expect(query).toContain('j.startedAt IS NULL');
    expect(params).toMatchObject({ jobId: 'job-1' });
    expect(ageMs).toBe(90000);
    expect(session.close).toHaveBeenCalled();
  });

  it('returns null when the job is missing or has no startedAt', async () => {
    const { session: noRow } = makeMockSession({ records: [] });
    expect(await getReloadJobAgeMs(makeMockDriver(noRow), 'missing')).toBeNull();

    const { session: nullAge } = makeMockSession({ records: [makeRecord({ ageMs: null })] });
    expect(await getReloadJobAgeMs(makeMockDriver(nullAge), 'job-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// read paths: getReloadJob / getLatestReloadJob / findResumableReloadJob
// ---------------------------------------------------------------------------
describe('getReloadJob', () => {
  it('maps the job and parses each stage countsJson', async () => {
    const record = makeRecord({
      jobId: 'job-1',
      status: 'running',
      startedAt: '2026-06-05T00:00:00Z',
      completedAt: null,
      durationMs: null,
      stages: [
        {
          stage: 'releases',
          ordinal: makeNeo4jInt(0),
          status: 'complete',
          startedAt: '2026-06-05T00:00:01Z',
          completedAt: '2026-06-05T00:00:02Z',
          countsJson: '{"releasesProcessed":3,"failedReleaseIds":[9,12]}',
          error: null,
        },
        {
          stage: 'lyrics',
          ordinal: makeNeo4jInt(1),
          status: 'running',
          startedAt: '2026-06-05T00:00:03Z',
          completedAt: null,
          countsJson: null,
          error: null,
        },
      ],
    });
    const { session } = makeMockSession({ records: [record] });

    const job = await getReloadJob(makeMockDriver(session), 'job-1');

    expect(job).not.toBeNull();
    expect(job?.jobId).toBe('job-1');
    expect(job?.status).toBe('running');
    expect(job?.startedAt).toBe('2026-06-05T00:00:00Z');
    expect(job?.stages).toHaveLength(2);
    expect(job?.stages[0]).toMatchObject({
      stage: 'releases',
      ordinal: 0,
      status: 'complete',
      // The array-valued count is reconstructed by parseCounts, not coerced/dropped (#417).
      counts: { releasesProcessed: 3, failedReleaseIds: [9, 12] },
    });
    // null/empty countsJson → {}
    expect(job?.stages[1]?.counts).toEqual({});
  });

  it('returns null when no job matches', async () => {
    const { session } = makeMockSession({ records: [] });
    const job = await getReloadJob(makeMockDriver(session), 'missing');
    expect(job).toBeNull();
  });

  it('coerces a malformed countsJson to an empty object', async () => {
    const record = makeRecord({
      jobId: 'job-1',
      status: 'complete',
      startedAt: '2026-06-05T00:00:00Z',
      completedAt: '2026-06-05T00:01:00Z',
      durationMs: makeNeo4jInt(60000),
      stages: [
        {
          stage: 'lyrics',
          ordinal: makeNeo4jInt(0),
          status: 'complete',
          startedAt: '2026-06-05T00:00:01Z',
          completedAt: '2026-06-05T00:00:02Z',
          countsJson: 'not json',
          error: null,
        },
      ],
    });
    const { session } = makeMockSession({ records: [record] });

    const job = await getReloadJob(makeMockDriver(session), 'job-1');
    expect(job?.durationMs).toBe(60000);
    expect(job?.stages[0]?.counts).toEqual({});
  });
});

describe('getLatestReloadJob', () => {
  it('selects the most recently started job', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    await getLatestReloadJob(makeMockDriver(session));

    const query = (runSpy.mock.calls[0] as [string])[0];
    expect(query).toContain('ORDER BY j.startedAt DESC LIMIT 1');
    expect(query).not.toContain("status: 'running'");
  });
});

describe('findResumableReloadJob', () => {
  it('filters to running jobs only', async () => {
    const { session, runSpy } = makeMockSession({ records: [] });
    const job = await findResumableReloadJob(makeMockDriver(session));

    const query = (runSpy.mock.calls[0] as [string])[0];
    expect(query).toContain("MATCH (j:ReloadJob {status: 'running'})");
    expect(job).toBeNull();
  });
});
