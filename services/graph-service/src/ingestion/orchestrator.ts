import type { Driver } from 'neo4j-driver';
import type { Logger } from './discogs-client.js';
import { buildDiscogsClientFromEnv } from './ingest.js';
import { buildMusicBrainzClientFromEnv } from './musicbrainz-client.js';
import { buildAcousticBrainzClientFromEnv } from './acousticbrainz-client.js';
import { buildDeezerClientFromEnv } from './deezer-client.js';
import { buildWikidataClientFromEnv } from './wikidata-client.js';
import { buildViafClientFromEnv } from './viaf-client.js';
import { RELOAD_STAGES } from './stages.js';
import type { ReloadContext, StageDescriptor } from './stages.js';
import { scheduleStages } from './scheduler.js';
import {
  createReloadJob,
  getReloadJob,
  markStageRunning,
  markStageComplete,
  markStageFailed,
  finishReloadJob,
} from '../db/job-repository.js';
import type { PersistedJob } from '../db/job-repository.js';

export interface RunReloadOptions {
  username: string;
  /** Defaults to console; pass app.log in production. */
  logger?: Logger;
  /** Resume the given job instead of starting a new one. Cold-start recovery passes this. */
  resumeJobId?: string;
  /**
   * Max stages running at once. Defaults to `RELOAD_STAGE_CONCURRENCY` (env) or 2, clamped to
   * `[1, stage count]`. Pass `1` for the legacy strictly-sequential behaviour.
   */
  concurrency?: number;
}

const DEFAULT_STAGE_CONCURRENCY = 2;

/**
 * Resolve the stage concurrency cap: explicit option → `RELOAD_STAGE_CONCURRENCY` env → default 2,
 * clamped to `[1, total]`. Default 2 keeps load modest for Aura Free + the single t3.small node;
 * raise it via the env var if the node has headroom.
 */
function resolveConcurrency(option: number | undefined, total: number): number {
  const fromEnv = parseInt(process.env['RELOAD_STAGE_CONCURRENCY'] ?? '', 10);
  const raw = option ?? (Number.isFinite(fromEnv) ? fromEnv : DEFAULT_STAGE_CONCURRENCY);
  return Math.min(Math.max(1, Math.floor(raw)), total);
}

export interface ReloadResult {
  jobId: string;
  status: 'complete' | 'failed';
  stagesRun: number;
  stagesSkipped: number;
  stagesFailed: number;
}

/**
 * Build the per-reload context once, using the same env builders the standalone /enrich
 * routes use so orchestrated stages behave identically. Clients whose env vars are absent
 * come back null; their stages then skip rather than fail.
 */
export function buildReloadContext(driver: Driver, username: string, log: Logger): ReloadContext {
  return {
    driver,
    log,
    username,
    discogs: buildDiscogsClientFromEnv(log),
    musicbrainz: buildMusicBrainzClientFromEnv(log),
    acousticbrainz: buildAcousticBrainzClientFromEnv(log),
    deezer: buildDeezerClientFromEnv(log),
    wikidata: buildWikidataClientFromEnv(log),
    viaf: buildViafClientFromEnv(log),
  };
}

/**
 * Run the orchestrated reload: every stage from RELOAD_STAGES, scheduled with bounded concurrency
 * and honouring each stage's `deps` + `resources` lanes, persisting per-stage checkpoints to Neo4j
 * so a killed pod resumes from where it left off.
 *
 * - Fresh run: creates a job with all stages `pending`.
 * - Resume (`resumeJobId`): reads the persisted job and skips stages already `complete`/`skipped`;
 *   any leftover `running` stages (with concurrency > 1 a crash can leave several) re-run, which is
 *   safe because each stage's idempotent candidate filters only pick up unfinished work.
 *
 * A stage that returns null is recorded `skipped` (its client was not configured); a stage that
 * throws is recorded `failed`, logged, and the rest of the schedule continues (failure isolation).
 * The job ends `failed` if any stage failed, else `complete` — only a still-`running` job (a
 * genuine mid-run crash) is resumable on the next boot.
 */
export async function runReload(driver: Driver, options: RunReloadOptions): Promise<ReloadResult> {
  const log: Logger = options.logger ?? console;
  const stageNames = RELOAD_STAGES.map((s) => s.name);

  let existing: PersistedJob | null = null;
  if (options.resumeJobId !== undefined) {
    existing = await getReloadJob(driver, options.resumeJobId);
    if (existing === null) {
      log.warn(`[reload] resumeJobId ${options.resumeJobId} not found — starting a fresh job`);
    }
  }

  const jobId = existing?.jobId ?? (await createReloadJob(driver, stageNames));

  // Stages already settled on a prior run are skipped on resume.
  const doneStages = new Set(
    (existing?.stages ?? [])
      .filter((s) => s.status === 'complete' || s.status === 'skipped')
      .map((s) => s.stage),
  );

  // Accurate whether the job is brand-new (pre-created by the route with all stages pending)
  // or a genuine resume after a crash (some stages already settled).
  log.info(
    doneStages.size > 0
      ? `[reload] resuming job ${jobId} — ${doneStages.size} stage(s) already done`
      : `[reload] starting job ${jobId}`,
  );

  const ctx = buildReloadContext(driver, options.username, log);
  const concurrency = resolveConcurrency(options.concurrency, RELOAD_STAGES.length);
  log.info(`[reload] scheduling ${RELOAD_STAGES.length} stage(s) at concurrency ${concurrency}`);

  let stagesRun = 0;
  let stagesSkipped = 0;
  let stagesFailed = 0;

  // Run one stage end-to-end. MUST NOT reject — a rejected run would abort the whole concurrent
  // schedule — so even a failed checkpoint write is swallowed after logging.
  const runOneStage = async (descriptor: StageDescriptor): Promise<void> => {
    try {
      await markStageRunning(driver, jobId, descriptor.name);
      const counts = await descriptor.run(ctx);
      if (counts === null) {
        await markStageComplete(driver, jobId, descriptor.name, {}, true);
        stagesSkipped++;
        log.info(`[reload] stage "${descriptor.name}" skipped — required client not configured`);
      } else {
        await markStageComplete(driver, jobId, descriptor.name, counts);
        stagesRun++;
        log.info(`[reload] stage "${descriptor.name}" complete`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stagesFailed++;
      try {
        await markStageFailed(driver, jobId, descriptor.name, msg);
      } catch (recordErr) {
        const rmsg = recordErr instanceof Error ? recordErr.message : String(recordErr);
        log.error(`[reload] stage "${descriptor.name}" failed; recording it also failed: ${rmsg}`);
      }
      log.error(`[reload] stage "${descriptor.name}" failed (recorded; continuing): ${msg}`);
    }
  };

  // Stages already settled on a prior run are skipped by the scheduler (and unblock their
  // dependents). With concurrency > 1 a crash can leave several stages `running`; all re-run here,
  // which is safe because each stage's idempotent candidate filters only pick up unfinished work.
  await scheduleStages({
    stages: RELOAD_STAGES,
    concurrency,
    alreadyDone: doneStages,
    run: runOneStage,
    log,
  });

  // A schedule that couldn't settle every stage (a malformed graph trips the scheduler's stuck
  // guard — unit-tested away, defensive here) is a failure, like any failed stage.
  const allSettled =
    stagesRun + stagesSkipped + stagesFailed + doneStages.size >= RELOAD_STAGES.length;
  const status: 'complete' | 'failed' = stagesFailed > 0 || !allSettled ? 'failed' : 'complete';
  await finishReloadJob(driver, jobId, status);
  log.info(
    `[reload] job ${jobId} ${status}: ${stagesRun} run, ${stagesSkipped} skipped, ${stagesFailed} failed`,
  );

  return { jobId, status, stagesRun, stagesSkipped, stagesFailed };
}
