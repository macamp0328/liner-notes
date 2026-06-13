import { randomUUID } from 'crypto';
import type { Driver, Session } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

/** Overall lifecycle of a single orchestrated reload run. */
export type ReloadJobStatus = 'running' | 'complete' | 'failed';

/**
 * Per-stage checkpoint status.
 * - `pending`  — created, not yet attempted
 * - `running`  — attempt in flight (a leftover `running` after a crash marks the resume point)
 * - `complete` — finished and produced a summary
 * - `skipped`  — deliberately not run (e.g. its upstream client was not configured)
 * - `failed`   — threw; the orchestrator logs, records, and continues (failure isolation)
 */
export type ReloadStageStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export interface PersistedStage {
  stage: string;
  ordinal: number;
  status: ReloadStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  counts: Record<string, number>;
  error: string | null;
}

export interface PersistedJob {
  jobId: string;
  status: ReloadJobStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  stages: PersistedStage[];
}

/** Cap stored error messages so a pathological upstream error can't bloat a node property. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Minimal logger surface — pino, console, and the reload `Logger` all satisfy it structurally.
 * Declared locally so this `db` module needs no backwards import from `ingestion`.
 */
type CheckpointLogger = { warn: (msg: string) => void };

function toNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  if (typeof (raw as Neo4jInt).toNumber === 'function') return (raw as Neo4jInt).toNumber();
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The checkpoint writers are `MATCH … SET`, which silently no-op when the target ReloadJob/ReloadStage
 * node is gone — e.g. a `/reset` wipe DETACH DELETEs it out from under an in-flight reload (#290).
 * Each writer RETURNs `count(...) AS matched`; this turns a zero match into a structured warning so
 * the otherwise-invisible no-op is diagnosable. No-op when no logger was passed.
 */
function warnIfUnmatched(
  matchedRaw: unknown,
  log: CheckpointLogger | undefined,
  context: string,
): void {
  if (log !== undefined && (toNumberOrNull(matchedRaw) ?? 0) === 0) {
    log.warn(`[job-repository] ${context} matched no node — deleted mid-reload? (#290)`);
  }
}

/** Neo4j DateTime values stringify to ISO-8601; null stays null. */
function toIso(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

function parseCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

interface RawStage {
  stage: string;
  ordinal: unknown;
  status: ReloadStageStatus;
  startedAt: unknown;
  completedAt: unknown;
  countsJson: unknown;
  error: string | null;
}

function mapStage(raw: RawStage): PersistedStage {
  return {
    stage: raw.stage,
    ordinal: toNumberOrNull(raw.ordinal) ?? 0,
    status: raw.status,
    startedAt: toIso(raw.startedAt),
    completedAt: toIso(raw.completedAt),
    counts: parseCounts(raw.countsJson),
    error: raw.error,
  };
}

/**
 * Shared projection for reading a job with its ordered stages. The caller supplies the
 * `MATCH`/selection clause that binds a single `j:ReloadJob`; this appends the stage
 * collection and mapping so getReloadJob / getLatestReloadJob / findResumableReloadJob
 * stay in lockstep.
 */
async function readSingleJob(
  session: Session,
  selectJobCypher: string,
  params: Record<string, unknown>,
): Promise<PersistedJob | null> {
  const result = await session.run(
    `${selectJobCypher}
     OPTIONAL MATCH (j)-[:HAS_STAGE]->(st:ReloadStage)
     WITH j, st ORDER BY st.ordinal
     WITH j, collect(st) AS sts
     RETURN j.jobId AS jobId, j.status AS status, j.startedAt AS startedAt,
            j.completedAt AS completedAt, j.durationMs AS durationMs,
            [s IN sts WHERE s IS NOT NULL | {
              stage: s.stage, ordinal: s.ordinal, status: s.status,
              startedAt: s.startedAt, completedAt: s.completedAt,
              countsJson: s.countsJson, error: s.error
            }] AS stages`,
    params,
  );
  const record = result.records[0];
  if (!record) return null;
  return {
    jobId: record.get('jobId') as string,
    status: record.get('status') as ReloadJobStatus,
    startedAt: toIso(record.get('startedAt')),
    completedAt: toIso(record.get('completedAt')),
    durationMs: toNumberOrNull(record.get('durationMs')),
    stages: (record.get('stages') as RawStage[]).map(mapStage),
  };
}

/**
 * Create a new reload job with one `pending` ReloadStage per stage name (preserving order
 * via `ordinal`). The job starts `running`. Returns the generated jobId.
 */
export async function createReloadJob(driver: Driver, stageNames: string[]): Promise<string> {
  const jobId = randomUUID();
  const session = driver.session();
  try {
    await session.run(
      `CREATE (j:ReloadJob {
         jobId: $jobId, status: 'running', startedAt: datetime(),
         completedAt: null, durationMs: null
       })
       WITH j
       UNWIND $stages AS s
       CREATE (st:ReloadStage {
         jobId: $jobId, stage: s.name, ordinal: s.ordinal, status: 'pending',
         startedAt: null, completedAt: null, countsJson: null, error: null
       })
       CREATE (j)-[:HAS_STAGE {ordinal: s.ordinal}]->(st)`,
      {
        jobId,
        stages: stageNames.map((name, i) => ({ name, ordinal: neo4j.int(i) })),
      },
    );
    return jobId;
  } finally {
    await session.close();
  }
}

export async function markStageRunning(
  driver: Driver,
  jobId: string,
  stage: string,
  log?: CheckpointLogger,
): Promise<void> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (st:ReloadStage {jobId: $jobId, stage: $stage})
       SET st.status = 'running', st.startedAt = datetime(), st.error = null
       RETURN count(st) AS matched`,
      { jobId, stage },
    );
    warnIfUnmatched(result.records[0]?.get('matched'), log, `markStageRunning(${jobId}/${stage})`);
  } finally {
    await session.close();
  }
}

/**
 * Mark a stage terminal-successful. `skipped = true` records that the stage was deliberately
 * not run (e.g. a missing upstream client) rather than completing work.
 */
export async function markStageComplete(
  driver: Driver,
  jobId: string,
  stage: string,
  counts: Record<string, number>,
  skipped = false,
  log?: CheckpointLogger,
): Promise<void> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (st:ReloadStage {jobId: $jobId, stage: $stage})
       SET st.status = $status, st.completedAt = datetime(),
           st.countsJson = $countsJson, st.error = null
       RETURN count(st) AS matched`,
      {
        jobId,
        stage,
        status: skipped ? 'skipped' : 'complete',
        countsJson: JSON.stringify(counts),
      },
    );
    warnIfUnmatched(result.records[0]?.get('matched'), log, `markStageComplete(${jobId}/${stage})`);
  } finally {
    await session.close();
  }
}

/**
 * Mark a stage failed. Optional `counts` lets a stage that produces a structured
 * result before failing (e.g. the verify gate) persist that report alongside the
 * error, so `/admin/reload/status` shows the per-metric detail and not just a
 * truncated message.
 */
export async function markStageFailed(
  driver: Driver,
  jobId: string,
  stage: string,
  error: string,
  counts?: Record<string, number>,
  log?: CheckpointLogger,
): Promise<void> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (st:ReloadStage {jobId: $jobId, stage: $stage})
       SET st.status = 'failed', st.completedAt = datetime(), st.error = $error` +
        (counts === undefined ? '' : ', st.countsJson = $countsJson') +
        ' RETURN count(st) AS matched',
      {
        jobId,
        stage,
        error: error.slice(0, MAX_ERROR_LENGTH),
        ...(counts === undefined ? {} : { countsJson: JSON.stringify(counts) }),
      },
    );
    warnIfUnmatched(result.records[0]?.get('matched'), log, `markStageFailed(${jobId}/${stage})`);
  } finally {
    await session.close();
  }
}

/**
 * Close out a job. `durationMs` is computed server-side from the stored `startedAt` so it
 * never depends on the client clock.
 */
export async function finishReloadJob(
  driver: Driver,
  jobId: string,
  status: ReloadJobStatus,
  log?: CheckpointLogger,
): Promise<void> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (j:ReloadJob {jobId: $jobId})
       SET j.status = $status, j.completedAt = datetime(),
           j.durationMs = datetime().epochMillis - j.startedAt.epochMillis
       RETURN count(j) AS matched`,
      { jobId, status },
    );
    warnIfUnmatched(result.records[0]?.get('matched'), log, `finishReloadJob(${jobId})`);
  } finally {
    await session.close();
  }
}

/**
 * Force a job terminal (`failed`) and fail any of its still-`running` stages — the operator escape
 * hatch (#326) for a job that is `running` in Neo4j but has no live pod executing it (cold-start
 * resume skipped for missing creds, or a crash whose `.catch` recovery never fired). Without this a
 * stuck job 409s every future `/reload` + `/reset` until a pod restart (#290). Atomic so a job with
 * zero running stages is still flipped: the job `SET` applies once before the `WITH j` boundary, and
 * the `OPTIONAL MATCH` keeps that single row when no stage matches (`count(st)` then 0). `count(DISTINCT
 * j)` — a plain `count(j)` would return the post-fan-out row count, not 1. Returns the number of stages
 * failed. Mirrors `finishReloadJob`'s server-side `durationMs` so it never depends on the client clock.
 */
export async function abortReloadJob(
  driver: Driver,
  jobId: string,
  log?: CheckpointLogger,
): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (j:ReloadJob {jobId: $jobId})
       SET j.status = 'failed', j.completedAt = datetime(),
           j.durationMs = datetime().epochMillis - j.startedAt.epochMillis
       WITH j
       OPTIONAL MATCH (j)-[:HAS_STAGE]->(st:ReloadStage {status: 'running'})
       SET st.status = 'failed', st.completedAt = datetime(), st.error = 'Aborted by operator'
       RETURN count(DISTINCT j) AS matched, count(st) AS abortedStages`,
      { jobId },
    );
    const record = result.records[0];
    warnIfUnmatched(record?.get('matched'), log, `abortReloadJob(${jobId})`);
    return toNumberOrNull(record?.get('abortedStages')) ?? 0;
  } finally {
    await session.close();
  }
}

export async function getReloadJob(driver: Driver, jobId: string): Promise<PersistedJob | null> {
  const session = driver.session();
  try {
    return await readSingleJob(session, 'MATCH (j:ReloadJob {jobId: $jobId})', { jobId });
  } finally {
    await session.close();
  }
}

/**
 * Age in milliseconds of a job since its `startedAt`, computed server-side (`datetime().epochMillis -
 * j.startedAt.epochMillis`) so it never depends on the client clock — and to avoid `Date.parse`-ing the
 * 9-fractional-digit ISO string `startedAt` stringifies to. Drives the `/reload/status` staleness signal
 * (#326). `null` when the job is missing or has no `startedAt`.
 */
export async function getReloadJobAgeMs(driver: Driver, jobId: string): Promise<number | null> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (j:ReloadJob {jobId: $jobId})
       RETURN CASE WHEN j.startedAt IS NULL THEN null
                   ELSE datetime().epochMillis - j.startedAt.epochMillis END AS ageMs`,
      { jobId },
    );
    return toNumberOrNull(result.records[0]?.get('ageMs'));
  } finally {
    await session.close();
  }
}

/** The most recently started reload job, regardless of status (for status display). */
export async function getLatestReloadJob(driver: Driver): Promise<PersistedJob | null> {
  const session = driver.session();
  try {
    return await readSingleJob(
      session,
      `MATCH (j:ReloadJob)
       WITH j ORDER BY j.startedAt DESC LIMIT 1`,
      {},
    );
  } finally {
    await session.close();
  }
}

/**
 * The most recently started job still `running` — i.e. one whose process died before
 * `finishReloadJob` ran. Drives cold-start resume. A `complete`/`failed` job is never
 * resumable; the operator re-triggers a fresh reload instead.
 */
export async function findResumableReloadJob(driver: Driver): Promise<PersistedJob | null> {
  const session = driver.session();
  try {
    return await readSingleJob(
      session,
      `MATCH (j:ReloadJob {status: 'running'})
       WITH j ORDER BY j.startedAt DESC LIMIT 1`,
      {},
    );
  } finally {
    await session.close();
  }
}
