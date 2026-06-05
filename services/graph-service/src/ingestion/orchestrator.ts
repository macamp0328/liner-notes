import type { Driver } from 'neo4j-driver';
import type { Logger } from './discogs-client.js';
import { buildDiscogsClientFromEnv } from './ingest.js';
import { buildMusicBrainzClientFromEnv } from './musicbrainz-client.js';
import { buildAcousticBrainzClientFromEnv } from './acousticbrainz-client.js';
import { buildDeezerClientFromEnv } from './deezer-client.js';
import { buildWikidataClientFromEnv } from './wikidata-client.js';
import { buildViafClientFromEnv } from './viaf-client.js';
import { RELOAD_STAGES } from './stages.js';
import type { ReloadContext } from './stages.js';
import {
  createReloadJob,
  getReloadJob,
  markStageRunning,
  markStageComplete,
  markStageFailed,
  finishReloadJob,
} from '../db/job-repository.js';
import type { PersistedJob } from '../db/job-repository.js';
import {
  markReloadActive,
  markReloadInactive,
  beginStage,
  reportStageProgress,
  clearStage,
} from './reload-progress.js';
import type { ProgressReporter } from '../enrichment/progress.js';

export interface RunReloadOptions {
  username: string;
  /** Defaults to console; pass app.log in production. */
  logger?: Logger;
  /** Resume the given job instead of starting a new one. Cold-start recovery passes this. */
  resumeJobId?: string;
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
 * Run the orchestrated reload: every stage in RELOAD_STAGES order, persisting per-stage
 * checkpoints to Neo4j so a killed pod resumes from the last completed stage.
 *
 * - Fresh run: creates a job with all stages `pending`.
 * - Resume (`resumeJobId`): reads the persisted job and skips stages already
 *   `complete`/`skipped`; the leftover `running` stage (the interrupted one) re-runs, which
 *   is safe because each stage's idempotent candidate filters only pick up unfinished work.
 *
 * A stage that returns null is recorded `skipped` (its client was not configured); a stage
 * that throws is recorded `failed`, logged, and the run continues (failure isolation). The
 * job ends `failed` if any stage failed, else `complete` — only a still-`running` job (a
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

  let stagesRun = 0;
  let stagesSkipped = 0;
  let stagesFailed = 0;

  // Flag the run active for the /stats cache + snapshot timer. The `finally` guarantees the
  // flag (and any live stage progress) is cleared even if a transition write throws.
  markReloadActive(jobId);
  try {
    for (const descriptor of RELOAD_STAGES) {
      if (doneStages.has(descriptor.name)) {
        log.info(`[reload] stage "${descriptor.name}" already done — skipping`);
        continue;
      }

      await markStageRunning(driver, jobId, descriptor.name);
      beginStage(jobId, descriptor.name);
      const onProgress: ProgressReporter = (processed, total) =>
        reportStageProgress(jobId, descriptor.name, processed, total);
      try {
        const counts = await descriptor.run(ctx, onProgress);
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
        await markStageFailed(driver, jobId, descriptor.name, msg);
        stagesFailed++;
        log.error(`[reload] stage "${descriptor.name}" failed (recorded; continuing): ${msg}`);
      }
      // Drop live progress between stages so the overlay reports a position only mid-stage.
      clearStage();
    }
  } finally {
    markReloadInactive(jobId);
  }

  const status = stagesFailed > 0 ? 'failed' : 'complete';
  await finishReloadJob(driver, jobId, status);
  log.info(
    `[reload] job ${jobId} ${status}: ${stagesRun} run, ${stagesSkipped} skipped, ${stagesFailed} failed`,
  );

  return { jobId, status, stagesRun, stagesSkipped, stagesFailed };
}
