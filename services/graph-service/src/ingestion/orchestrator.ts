import type { Driver } from 'neo4j-driver';
import type { Logger } from './discogs-client.js';
import { buildDiscogsClientFromEnv } from './ingest.js';
import { buildMusicBrainzClientFromEnv } from './musicbrainz-client.js';
import { buildAcousticBrainzClientFromEnv } from './acousticbrainz-client.js';
import { buildDeezerClientFromEnv } from './deezer-client.js';
import { buildWikidataClientFromEnv } from './wikidata-client.js';
import { RELOAD_STAGES, foldBreakerCounts } from './stages.js';
import type { ReloadContext, ReloadStageName, StageDescriptor } from './stages.js';
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
import {
  markReloadActive,
  markReloadInactive,
  beginStage,
  reportStageProgress,
  clearStage,
} from './reload-progress.js';
import type { ProgressReporter } from '../enrichment/progress.js';
import { getStats } from '../db/stats-repository.js';
import { evaluateCoverage, reportToCounts, formatVerifyFailure } from './reload-verify.js';

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
 *
 * The env var must be an all-digits string to count — a malformed value like `"2foo"` or `"foo"`
 * falls back to the default rather than `parseInt`-ing to its leading digits.
 */
export function resolveConcurrency(option: number | undefined, total: number): number {
  const clamp = (n: number): number => Math.min(Math.max(1, Math.floor(n)), total);
  if (option !== undefined && Number.isFinite(option)) return clamp(option);
  const raw = process.env['RELOAD_STAGE_CONCURRENCY']?.trim() ?? '';
  return /^[0-9]+$/.test(raw) ? clamp(Number(raw)) : DEFAULT_STAGE_CONCURRENCY;
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
 * `verify` runs last (its deps cover every other stage) as the #178 coverage gate. The job ends
 * `failed` if any stage failed, else `complete` — only a still-`running` job (a genuine mid-run
 * crash) is resumable on the next boot.
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

  // Stages that produced output (status `complete`, not `skipped`) — across both a prior run's
  // checkpoints and this run. The verify gate judges coverage only for stages that actually ran,
  // so a skipped stage's metric is exempt rather than a false silently-zero. Mutated as stages
  // complete; `verify` deps on every other stage, so it reads a fully-populated set.
  const ranStages = new Set<ReloadStageName>(
    (existing?.stages ?? [])
      .filter((s) => s.status === 'complete')
      .map((s) => s.stage as ReloadStageName),
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
  // schedule — so even a failed checkpoint write is swallowed after logging. Each stage feeds the
  // live-progress mirror (#179): begin on start, forward an onProgress reporter, clear on settle.
  const runOneStage = async (descriptor: StageDescriptor): Promise<void> => {
    const onProgress: ProgressReporter = (processed, total) =>
      reportStageProgress(jobId, descriptor.name, processed, total);
    try {
      await markStageRunning(driver, jobId, descriptor.name, log);

      // The verify gate (#178) runs here, not via descriptor.run, because it needs `ranStages`
      // (which stages produced output this job) that the run(ctx) signature can't carry. Its deps
      // cover every other stage, so the scheduler runs it last and alone; it does no per-item work,
      // so it skips the live-progress registry (no beginStage).
      if (descriptor.name === 'verify') {
        const { passed } = await runVerifyGate(driver, jobId, ranStages, log);
        if (passed) stagesRun++;
        else stagesFailed++;
        return;
      }

      beginStage(jobId, descriptor.name);
      const counts = await descriptor.run(ctx, onProgress);
      if (counts === null) {
        await markStageComplete(driver, jobId, descriptor.name, {}, true, log);
        stagesSkipped++;
        log.info(`[reload] stage "${descriptor.name}" skipped — required client not configured`);
      } else {
        await markStageComplete(
          driver,
          jobId,
          descriptor.name,
          foldBreakerCounts(ctx, descriptor, counts),
          false,
          log,
        );
        stagesRun++;
        ranStages.add(descriptor.name);
        log.info(`[reload] stage "${descriptor.name}" complete`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stagesFailed++;
      try {
        // Surface any breaker that tripped before the stage threw, even on the failure path.
        await markStageFailed(
          driver,
          jobId,
          descriptor.name,
          msg,
          foldBreakerCounts(ctx, descriptor, {}),
          log,
        );
        log.error(`[reload] stage "${descriptor.name}" failed (recorded; continuing): ${msg}`);
      } catch (recordErr) {
        const rmsg = recordErr instanceof Error ? recordErr.message : String(recordErr);
        log.error(
          `[reload] stage "${descriptor.name}" failed AND recording it failed (continuing): ${msg} / ${rmsg}`,
        );
      }
    } finally {
      // Drop this stage's live progress on settle, keyed by name so it never wipes a still-running
      // sibling's slot under concurrency (the #179 mirror tracks one entry per running stage).
      clearStage(jobId, descriptor.name);
    }
  };

  // Stages already settled on a prior run are skipped by the scheduler (and unblock their
  // dependents). With concurrency > 1 a crash can leave several stages `running`; all re-run here,
  // which is safe because each stage's idempotent candidate filters only pick up unfinished work.
  // markReloadActive flags the run for the /stats cache + snapshot timer; the `finally` guarantees
  // the flag (and any live stage progress) is cleared even if the schedule throws.
  markReloadActive(jobId);
  try {
    await scheduleStages({
      stages: RELOAD_STAGES,
      concurrency,
      alreadyDone: doneStages,
      run: runOneStage,
      log,
    });
  } finally {
    markReloadInactive(jobId);
  }

  // A schedule that couldn't settle every stage (a malformed graph trips the scheduler's stuck
  // guard — unit-tested away, defensive here) is a failure, like any failed stage.
  const allSettled =
    stagesRun + stagesSkipped + stagesFailed + doneStages.size >= RELOAD_STAGES.length;
  const status: 'complete' | 'failed' = stagesFailed > 0 || !allSettled ? 'failed' : 'complete';
  await finishReloadJob(driver, jobId, status, log);
  log.info(
    `[reload] job ${jobId} ${status}: ${stagesRun} run, ${stagesSkipped} skipped, ${stagesFailed} failed`,
  );

  return { jobId, status, stagesRun, stagesSkipped, stagesFailed };
}

/**
 * The verify gate (#178). Reads coverage via `getStats`, compares it against the
 * pinned thresholds for the stages that ran (`ranStages`), and records the result
 * on the verify ReloadStage. On failure it logs at pino error level (≥ 50, so the
 * CloudWatch `$.data.level >= 50` filter and the #169 dashboard fire) and persists
 * the structured per-metric report alongside the failure summary, so a degraded
 * load surfaces in `/admin/reload/status` rather than reporting green.
 */
export async function runVerifyGate(
  driver: Driver,
  jobId: string,
  ranStages: ReadonlySet<ReloadStageName>,
  log: Logger,
): Promise<{ passed: boolean }> {
  try {
    const report = evaluateCoverage(await getStats(driver), ranStages);
    const counts = reportToCounts(report);
    if (report.pass) {
      await markStageComplete(driver, jobId, 'verify', counts, false, log);
      log.info('[reload] verify gate passed');
      return { passed: true };
    }
    const summary = formatVerifyFailure(report);
    log.error(`[reload] ${summary}`);
    await markStageFailed(driver, jobId, 'verify', summary, counts, log);
    return { passed: false };
  } catch (err) {
    const msg = `verify gate errored: ${err instanceof Error ? err.message : String(err)}`;
    log.error(`[reload] ${msg}`);
    await markStageFailed(driver, jobId, 'verify', msg, undefined, log);
    return { passed: false };
  }
}
