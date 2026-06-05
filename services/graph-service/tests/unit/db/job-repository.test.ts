import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
import {
  createReloadJob,
  markStageRunning,
  markStageComplete,
  markStageFailed,
  finishReloadJob,
  getReloadJob,
  getLatestReloadJob,
  findResumableReloadJob,
} from '../../../src/db/job-repository.js';

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
          countsJson: '{"releasesProcessed":3}',
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
      counts: { releasesProcessed: 3 },
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
