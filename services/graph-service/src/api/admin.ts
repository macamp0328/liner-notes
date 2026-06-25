import type { FastifyInstance } from 'fastify';
import type { Driver } from 'neo4j-driver';
import { adminAuthHook } from './middleware/admin-auth.js';
import { getDriver } from '../db/client.js';
import { wipeGraph } from '../db/ingestion-repository.js';
import { buildDiscogsClientFromEnv, runIngestion } from '../ingestion/ingest.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getJobState,
  startJob,
  completeJob,
  failJob,
  type IngestionStats,
} from '../ingestion/job-state.js';
import { clearGeniusLyrics } from '../db/lyrics-repository.js';
import {
  STAGE_DEFINITIONS,
  CLIENT_REGISTRY,
  buildClientsFromEnv,
  type StageDefinition,
  type PipelineResetConfig,
} from '../ingestion/stage-definitions.js';
import { runReload } from '../ingestion/orchestrator.js';
import { RELOAD_STAGES } from '../ingestion/stages.js';
import {
  abortReloadJob,
  createReloadJob,
  finishReloadJob,
  findResumableReloadJob,
  getLatestReloadJob,
  getReloadJobAgeMs,
} from '../db/job-repository.js';
import type { PersistedJob, PersistedStage } from '../db/job-repository.js';
import {
  getLiveProgress,
  isReloadActive,
  markReloadActive,
  markReloadInactive,
  type LiveStageProgress,
} from '../ingestion/reload-progress.js';
import { trackBackgroundJob } from '../lifecycle/shutdown.js';
import { errorResponseRef } from './schemas.js';

const statsShape = {
  type: 'object',
  nullable: true,
  properties: {
    nodes: { type: 'object', additionalProperties: { type: 'number' } },
    relationships: { type: 'object', additionalProperties: { type: 'number' } },
    lyricsEnriched: { type: 'number' },
    lyricsSkipped: { type: 'number' },
    lyricsFailed: { type: 'number' },
    errorCount: { type: 'number' },
    errors: { type: 'array', items: { type: 'string' } },
  },
} as const;

const jobStateShape = {
  type: 'object',
  required: ['status', 'jobId'],
  properties: {
    status: { type: 'string', enum: ['idle', 'running', 'complete', 'failed'] },
    jobId: { type: 'string' },
    startedAt: { type: 'string', nullable: true },
    completedAt: { type: 'string', nullable: true },
    durationMs: { type: 'number', nullable: true },
    stats: statsShape,
  },
} as const;

// Persisted orchestrated-reload job (issue #175). `null` when no reload has ever run.
const reloadJobShape = {
  type: 'object',
  nullable: true,
  required: ['jobId', 'status', 'stages'],
  properties: {
    jobId: { type: 'string' },
    status: { type: 'string', enum: ['running', 'complete', 'failed'] },
    startedAt: { type: 'string', nullable: true },
    completedAt: { type: 'string', nullable: true },
    durationMs: { type: 'number', nullable: true },
    // Staleness signal (#326), attached by the /reload/status handler. `ageMs` is the
    // server-computed age of a running job; `stale` flags a running job past
    // RELOAD_STALE_AFTER_HOURS with no live pod on it (a candidate for /reload/abort). Both are
    // optional, not required — overlayLiveProgress returns the raw job unchanged on several paths.
    ageMs: { type: 'number', nullable: true },
    stale: { type: 'boolean' },
    stages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['stage', 'status'],
        properties: {
          stage: { type: 'string' },
          ordinal: { type: 'number' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'complete', 'failed', 'skipped'],
          },
          startedAt: { type: 'string', nullable: true },
          completedAt: { type: 'string', nullable: true },
          // Counts are numeric, except the releases stage's bounded `failedReleaseIds` array (#417):
          // the `anyOf` is required so fast-json-stringify serializes the array instead of stripping it.
          counts: {
            type: 'object',
            additionalProperties: {
              anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'integer' } }],
            },
          },
          error: { type: 'string', nullable: true },
          // Live overlay (#179): present only on the stage currently running, sourced from the
          // in-memory progress registry. `etaMs` is a rough linear extrapolation for that stage.
          processed: { type: 'number', nullable: true },
          total: { type: 'number', nullable: true },
          etaMs: { type: 'number', nullable: true },
        },
      },
    },
  },
} as const;

/** A persisted stage plus the live overlay fields the /reload/status handler may attach. */
type StageView = PersistedStage & {
  processed?: number;
  total?: number;
  etaMs?: number | null;
};

/**
 * The /reload/status payload: the persisted job with live progress overlaid on its running stage,
 * plus the #326 staleness signal (`ageMs`/`stale`) the handler attaches after `overlayLiveProgress`.
 */
type ReloadJobView =
  | (Omit<PersistedJob, 'stages'> & { stages: StageView[]; ageMs?: number | null; stale?: boolean })
  | null;

/**
 * Overlay the live in-memory progress (processed/total + a rough ETA) onto the running stage of
 * a persisted reload job. Pure so the ETA math is unit-testable without a Fastify app. Returns
 * the job unchanged unless it's `running` and the live registry matches its jobId; ETA is null
 * when it can't be extrapolated (no progress yet, or the stage is effectively done).
 */
export function overlayLiveProgress(
  job: PersistedJob | null,
  live: LiveStageProgress | null,
  nowMs: number,
): ReloadJobView {
  if (job === null) return null;
  if (job.status !== 'running' || live === null || live.jobId !== job.jobId) return job;
  return {
    ...job,
    stages: job.stages.map((s) => {
      if (s.stage !== live.stage || s.status !== 'running') return s;
      const remaining = live.total - live.processed;
      const etaMs =
        live.processed > 0 && live.total > 0 && remaining > 0
          ? Math.round(((nowMs - live.stageStartedAtMs) / live.processed) * remaining)
          : null;
      return { ...s, processed: live.processed, total: live.total, etaMs };
    }),
  };
}

/** Default age before a running reload with no live pod is flagged stale (#326). */
const DEFAULT_RELOAD_STALE_AFTER_HOURS = 12;

/**
 * Resolve the staleness threshold (ms) from `RELOAD_STALE_AFTER_HOURS`. All-digits or fall back to
 * the default — a malformed value like `"12foo"` resolves to the default rather than `parseInt`-ing
 * to its leading digits (matching `resolveConcurrency`). Default 12 h is well above a full reload's
 * ~4–6 h, so a legitimately-long live run never trips it.
 */
export function resolveStaleAfterMs(): number {
  const raw = process.env['RELOAD_STALE_AFTER_HOURS']?.trim() ?? '';
  const hours = /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_RELOAD_STALE_AFTER_HOURS;
  return hours * 3_600_000;
}

/**
 * Staleness signal for /reload/status (#326). A reload is `stale` when it is `running` in Neo4j,
 * older than `staleAfterMs`, and has no live pod on it (`!isActive`) — i.e. a job stuck `running`
 * after a crash/missing-creds cold start, a candidate for `POST /reload/abort`. Pure (takes the
 * DB-computed `ageMs`, never `Date.parse`s the 9-digit `startedAt`) so it is unit-testable without
 * a Fastify app. `stale` requires `!isActive` so a legitimately-long live reload is never flagged;
 * a *freshly* stuck job (age below the threshold) is not yet `stale` — abort clears it regardless,
 * this is only the discovery aid.
 */
export function reloadStaleness(
  job: PersistedJob | null,
  isActive: boolean,
  ageMs: number | null,
  staleAfterMs: number,
): { ageMs: number | null; stale: boolean } {
  if (job === null || job.status !== 'running' || ageMs === null) {
    return { ageMs: null, stale: false };
  }
  return { ageMs, stale: !isActive && ageMs > staleAfterMs };
}

interface PipelineState {
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  lastResult: Record<string, unknown> | null;
  lastError: string | null;
}

function makePipelineState(): PipelineState {
  return {
    running: false,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    lastResult: null,
    lastError: null,
  };
}

/**
 * The outcome of building a pipeline's external client(s) from env: either a runnable
 * closure over the prepared clients, or the 503 message naming the missing variable.
 * `prepare` MUST stay synchronous — the enrich handler has no await between the 409
 * running-check and `running = true`, which is what keeps that guard atomic.
 */
type PreparedRun =
  | { ok: true; run: (driver: Driver) => Promise<Record<string, unknown>> }
  | { ok: false; message: string };

/**
 * One standalone-enrichment pipeline (issue #222 phase ③). The registry replaces nine
 * hand-written `/enrich` + `/status` (+ six `/reset`) route blocks and their per-pipeline
 * mutable state globals; `adminRoutes` generates the routes from this array. Entries hold
 * the OpenAPI strings/schemas VERBATIM from the routes they replaced — except the `/enrich`
 * response, which #280 flipped to a fire-and-forget 202 (run continues in the background;
 * poll `/status`), so the enrich body no longer carries a summary.
 */
interface PipelineEntry {
  /** Path segment: POST /<name>/enrich, GET /<name>/status, optional POST /<name>/reset. */
  name: string;
  /** Fills "Status of the most recent <statusLabel> run". */
  statusLabel: string;
  /** 409 body message while this pipeline is running. */
  runningMessage: string;
  enrichSummary: string;
  enrichDescription: string;
  /** `lastResult` schema for /status — historically most variants declare no `required`. */
  statusSummarySchema: Record<string, unknown>;
  /**
   * Whether the /enrich schema declares a 503 response. Independent of whether `prepare`
   * can actually fail: lyrics declares one but its prepare never fails.
   */
  schemaHas503: boolean;
  /**
   * master-data and artist-profiles historically checked the client BEFORE the running
   * flag (503 wins over 409); every other pipeline checks 409 first. Preserved as data.
   */
  clientCheckFirst: boolean;
  prepare(log: Logger): PreparedRun;
  reset?: PipelineResetConfig;
  state: PipelineState;
}

/**
 * Derive a standalone-enrichment {@link PipelineEntry} from a {@link StageDefinition} (#477) — the
 * admin half of the single source of truth (the reload half is `toStageDescriptor` in
 * stage-definitions.ts). `prepare` builds every client from env, then gates on the stage's `requires`
 * client: a missing one returns the 503 message from {@link CLIENT_REGISTRY} (the admin counterpart of
 * the reload-skip), otherwise it runs `enrich` with NO progress reporter (so the enrich fn uses its
 * NOOP default — admin runs never report progress). Each entry gets its own fresh mutable state.
 */
export function toPipelineEntry(def: StageDefinition): PipelineEntry {
  return {
    name: def.name,
    statusLabel: def.statusLabel,
    runningMessage: def.runningMessage,
    enrichSummary: def.enrichSummary,
    enrichDescription: def.enrichDescription,
    statusSummarySchema: def.statusSummarySchema,
    schemaHas503: def.schemaHas503,
    clientCheckFirst: def.clientCheckFirst,
    prepare: (log): PreparedRun => {
      const clients = buildClientsFromEnv(log);
      if (def.requires !== undefined && clients[def.requires] === null) {
        return { ok: false, message: CLIENT_REGISTRY[def.requires].missingMessage };
      }
      return { ok: true, run: (driver) => def.enrich(clients, driver, log) };
    },
    ...(def.reset !== undefined ? { reset: def.reset } : {}),
    state: makePipelineState(),
  };
}

// Array order = route registration order = STAGE_DEFINITIONS order (the order the original
// hand-written blocks appeared in this file). fastify-swagger emits paths in registration order and
// the committed docs/openapi.json is a raw stringify, so reordering entries churns the docs.
const PIPELINES: PipelineEntry[] = STAGE_DEFINITIONS.map(toPipelineEntry);

// Shared "is another graph-writing job in flight?" guard (#300). Consults the three in-memory,
// synchronous signals — the ingest job (`job-state.ts`), the reload-active flag
// (`reload-progress.ts`), and the per-pipeline running flags — and returns the 409 body to send, or
// null if idle. Every mutating admin route calls it so the whole surface enforces "only one
// graph-writing job at a time" (the reload, an /ingest job, and the enrichments all contend on the
// same rate-limited Discogs/MusicBrainz clients). Callers pass `ignore` to skip the signal they
// already guard with their own, richer 409 — ingest/reload carry a jobId, and enrich/reset own a
// *per-pipeline* flag (so they ignore the global `enrich` scan here, which would otherwise block a
// different concurrent stage that shares no client — the #176 lanes overlap by design). All three
// reads are synchronous, so a caller can drop this in before any atomic `running = true` set without
// introducing an await (preserving the #281 guard invariant). Point-in-time only: a job that starts
// *after* the check passes isn't blocked mid-run — this closes the operator-error window, not every
// interleave; MERGE-idempotency is the backstop, same as #281.
export function busyWith(
  ignore: { ingest?: boolean; reload?: boolean; enrich?: boolean } = {},
): { code: string; message: string } | null {
  if (!ignore.ingest && getJobState().status === 'running') {
    return { code: 'JOB_RUNNING', message: 'Ingestion is in progress' };
  }
  if (!ignore.reload && isReloadActive()) {
    return { code: 'RELOAD_RUNNING', message: 'A reload is in progress' };
  }
  if (!ignore.enrich) {
    const running = PIPELINES.find((e) => e.state.running);
    if (running) {
      return { code: 'ENRICHMENT_RUNNING', message: `${running.statusLabel} is in progress` };
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Reply:
      | { data: { jobId: string; message: string } }
      | { error: { code: string; message: string; jobId?: string } };
  }>(
    '/ingest',
    {
      schema: {
        tags: ['admin'],
        summary: 'Trigger the full Discogs → Neo4j ingestion pipeline',
        description:
          'Runs asynchronously — returns 202 immediately and processes in the background.\n\n' +
          '**Steps run automatically:**\n' +
          '1. Fetch & MERGE all releases from the Discogs collection\n' +
          '2. Lyrics enrichment (LRCLIB primary, Genius fallback)\n' +
          '3. Master data enrichment (originalYear + global pressing countries/formats via Discogs master API)\n' +
          '4. Artist genres/styles aggregation (rolled up from releases)\n' +
          '5. Artist profiles enrichment (realName + profile from Discogs artist API)\n\n' +
          '**Not included — must be triggered separately:**\n' +
          '- `POST /api/v1/admin/nationality/enrich` — nationality data from MusicBrainz + Wikidata\n' +
          '- `POST /api/v1/admin/mb-release-events/enrich` — ISO-coded country + date release events from MusicBrainz\n' +
          '- `POST /api/v1/admin/track-musicbrainz/enrich` — recording MBID + ISRC on Track nodes from MusicBrainz\n' +
          '- `POST /api/v1/admin/track-acousticbrainz/enrich` — tempo/key/loudness audio features on Track nodes from AcousticBrainz\n' +
          '- `POST /api/v1/admin/track-deezer/enrich` — BPM + loudness on Track nodes from Deezer (ISRC lookup)',
        security: [{ bearerAuth: [] }],
        response: {
          202: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['jobId', 'message'],
                properties: {
                  jobId: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          401: errorResponseRef,
          // Two 409 variants: this route's own JOB_RUNNING carries the conflicting ingest job's
          // jobId; the cross-job RELOAD_RUNNING / ENRICHMENT_RUNNING from busyWith() (#300) have
          // none — so jobId is optional, not required (fast-json-stringify omits it when absent).
          409: {
            type: 'object',
            required: ['error'],
            properties: {
              error: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  jobId: { type: 'string' },
                },
              },
            },
          },
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      const current = getJobState();
      if (current.status === 'running') {
        return reply.code(409).send({
          error: {
            code: 'JOB_RUNNING',
            message: 'Ingestion already in progress',
            jobId: current.jobId,
          },
        });
      }

      // runIngestion itself runs the lyrics/master-data/artist-genres/artist-profiles enrichments,
      // so it contends with a reload or a standalone enrich on the same rate-limited clients (#300).
      const busy = busyWith({ ingest: true });
      if (busy) {
        return reply.code(409).send({ error: busy });
      }

      const username = process.env['DISCOGS_USERNAME'];
      const discogsClient = buildDiscogsClientFromEnv(request.log);

      if (!discogsClient || !username) {
        request.log.warn(
          'POST /ingest: DISCOGS_TOKEN or DISCOGS_USERNAME not set — cannot trigger ingestion',
        );
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Discogs credentials not configured',
          },
        });
      }

      const jobId = startJob();
      const driver = getDriver();

      // Track the detached run so graceful shutdown drains it before closing the driver (#291).
      const ingestRun = runIngestion(discogsClient, driver, { username, logger: request.log })
        .then((summary) => {
          const stats: IngestionStats = {
            nodes: {},
            relationships: {},
            lyricsEnriched: summary.lyricsEnrichment.enriched,
            lyricsSkipped: summary.lyricsEnrichment.skipped,
            lyricsFailed: summary.lyricsEnrichment.failed,
            errorCount: summary.errors.length,
            errors: summary.errors.slice(0, 50),
          };
          completeJob(stats);
        })
        .catch((err: unknown) => {
          failJob(err instanceof Error ? err.message : String(err));
        });
      trackBackgroundJob(ingestRun);

      return reply.code(202).send({ data: { jobId, message: 'Ingestion started' } });
    },
  );

  fastify.get<{ Reply: { data: ReturnType<typeof getJobState> } }>(
    '/ingest/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get the status of the current or last ingestion job',
        description:
          'Returns the job state for the ingestion triggered by `POST /api/v1/admin/ingest`. ' +
          'Status values: `idle` (never run), `running`, `complete`, `failed`. ' +
          'Does not reflect the status of standalone enrichment endpoints (`/api/v1/admin/lyrics/enrich`, `/api/v1/admin/nationality/enrich`).',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: jobStateShape,
            },
          },
          401: errorResponseRef,
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      return reply.send({ data: getJobState() });
    },
  );

  fastify.post<{
    Querystring: { confirm?: string };
    Reply: { data: { deleted: number } } | { error: { code: string; message: string } };
  }>(
    '/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Wipe the entire graph (destructive)',
        description:
          '**Deletes ALL nodes and relationships** via `MATCH (n) DETACH DELETE n`. ' +
          'Intended for a deliberate "wipe and reload from scratch" — the graph is fully ' +
          'reconstructable from Discogs, so there is no separate backup to restore.\n\n' +
          'Double-gated: requires the `ADMIN_TOKEN` bearer **and** an explicit `?confirm=wipe-all` ' +
          'query parameter. Without the exact confirm value it returns 400 and changes nothing.\n\n' +
          'After wiping, restart the pod (or call `POST /api/v1/admin/ingest`) to re-ingest: an empty ' +
          'graph auto-triggers ingestion on startup.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            confirm: { type: 'string', description: 'Must equal "wipe-all" to proceed.' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['deleted'],
                properties: { deleted: { type: 'integer' } },
              },
            },
          },
          400: errorResponseRef,
          401: errorResponseRef,
          409: errorResponseRef,
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (request.query.confirm !== 'wipe-all') {
        return reply.code(400).send({
          error: {
            code: 'CONFIRMATION_REQUIRED',
            message: 'Refusing to wipe the graph without ?confirm=wipe-all',
          },
        });
      }
      // A wipe DETACH DELETEs nodes a concurrent reload/ingest/enrich is MERGE-writing — the most
      // destructive race, so refuse while any graph-writing job is in flight (#300).
      const busy = busyWith();
      if (busy) {
        return reply.code(409).send({ error: busy });
      }
      // busyWith() only sees the in-memory reload flag; a reload job that is `running` in Neo4j but
      // has no live pod on it (cold-start resume skipped for missing creds, or a crash not yet
      // resumed) is invisible to it. Wiping then DETACH DELETEs that job's ReloadJob/ReloadStage
      // checkpoints and the orphaned orchestrator's writes silently no-op — re-arming a second
      // concurrent reload (#290). Refuse while any reload job is still resumable.
      const resumable = await findResumableReloadJob(getDriver());
      if (resumable) {
        return reply.code(409).send({
          error: {
            code: 'RELOAD_RUNNING',
            message: 'A reload job is still in progress — let it finish or resume before wiping',
          },
        });
      }
      const deleted = await wipeGraph(getDriver());
      // Log at error level (Pino 50) so this destructive action trips the
      // CloudWatch error metric filter (`$.data.level >= 50`) — a graph wipe is
      // rare and high-impact enough to warrant surfacing as an alertable event.
      request.log.error(`[admin] Graph wiped via POST /reset — ${deleted} nodes deleted`);
      return reply.send({ data: { deleted } });
    },
  );

  fastify.post<{
    Reply: { data: { cleared: number } } | { error: { code: string; message: string } };
  }>(
    '/lyrics/clear-genius',
    {
      schema: {
        tags: ['admin'],
        summary: 'Clear all Genius-sourced lyrics for re-enrichment',
        description:
          'Sets `lyrics` and `lyricsSource` to null on every Track node where `lyricsSource = "genius"`. ' +
          'Those tracks become lyrics-null candidates again for the next enrichment pass.\n\n' +
          'Use this when Genius data quality is poor, or before re-running the Genius harvest. ' +
          'After clearing, re-fetch via the operator-side residential harvest `pnpm lyrics:enrich:local` ' +
          '(see `services/graph-service/scripts/lyrics-enrich-local.ts`) — NOT `POST /api/v1/admin/lyrics/enrich`, ' +
          'which in prod is LRCLIB-only and re-fetches nothing from Genius (prod leaves `GENIUS_TOKEN` unset, #258; ' +
          'Genius 403s the prod IP, #240).',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['cleared'],
                properties: { cleared: { type: 'integer' } },
              },
            },
          },
          401: errorResponseRef,
          409: errorResponseRef,
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      // Nulling Genius lyrics mid reload-lyrics-stage (or mid lyrics-enrich) would clobber freshly
      // written rows, so refuse while any graph-writing job is in flight (#300). This route owns no
      // running flag of its own, so the shared check is its whole guard.
      const busy = busyWith();
      if (busy) {
        return reply.code(409).send({ error: busy });
      }
      const cleared = await clearGeniusLyrics(getDriver());
      return reply.send({ data: { cleared } });
    },
  );

  // ── Standalone enrichment pipelines (issue #222 phase ③) ───────────────────
  // POST /<name>/enrich and POST /<name>/reset are generated per registry entry,
  // interleaved so route registration order matches the original hand-written blocks
  // (the committed OpenAPI doc emits paths in registration order).
  for (const entry of PIPELINES) {
    fastify.post<{
      Reply:
        | { data: { message: string; statusUrl: string } }
        | { error: { code: string; message: string } };
    }>(
      `/${entry.name}/enrich`,
      {
        schema: {
          tags: ['admin'],
          summary: entry.enrichSummary,
          description: entry.enrichDescription,
          security: [{ bearerAuth: [] }],
          response: {
            202: {
              type: 'object',
              required: ['data'],
              properties: {
                data: {
                  type: 'object',
                  required: ['message', 'statusUrl'],
                  properties: { message: { type: 'string' }, statusUrl: { type: 'string' } },
                },
              },
            },
            401: errorResponseRef,
            409: errorResponseRef,
            ...(entry.schemaHas503 ? { 503: errorResponseRef } : {}),
          },
        },
        preHandler: adminAuthHook,
      },
      async (request, reply) => {
        // A reload owns the shared rate-limited clients (and the #176 scheduler serialises its
        // lanes), so refuse a standalone enrich while one is in flight (#281). isReloadActive() is
        // synchronous, so this adds no await before the running-flag guard below — that guard stays
        // atomic. Deliberate precedence: RELOAD_RUNNING > JOB_RUNNING > SERVICE_UNAVAILABLE >
        // ENRICHMENT_RUNNING. Point-in-time only: a reload starting *after* this passes isn't
        // blocked mid-run, but writes are MERGE-idempotent, so this closes the operator-error
        // window, not every race.
        if (isReloadActive()) {
          return reply.code(409).send({
            error: {
              code: 'RELOAD_RUNNING',
              message: `Cannot run ${entry.statusLabel} while a reload is in progress`,
            },
          });
        }

        // Also refuse while an /ingest job runs — runIngestion enriches too, contending on the same
        // clients (#300). `ignore.enrich` here is deliberate: a *different* standalone enrich stage
        // may legitimately run concurrently (the #176 lanes overlap); this stage's own contention is
        // covered by the per-pipeline `entry.state.running` guard below. Still synchronous, so the
        // atomic running-flag set stays await-free.
        const busy = busyWith({ reload: true, enrich: true });
        if (busy) {
          return reply.code(409).send({ error: busy });
        }

        let prepared: PreparedRun | null = null;

        if (entry.clientCheckFirst) {
          prepared = entry.prepare(request.log);
          if (!prepared.ok) {
            return reply.code(503).send({
              error: { code: 'SERVICE_UNAVAILABLE', message: prepared.message },
            });
          }
        }

        if (entry.state.running) {
          return reply.code(409).send({
            error: { code: 'ENRICHMENT_RUNNING', message: entry.runningMessage },
          });
        }

        if (prepared === null) {
          prepared = entry.prepare(request.log);
          if (!prepared.ok) {
            return reply.code(503).send({
              error: { code: 'SERVICE_UNAVAILABLE', message: prepared.message },
            });
          }
        }

        // No await between the 409 check above and `running = true` keeps the guard atomic.
        entry.state.running = true;
        entry.state.startedAt = new Date().toISOString();
        entry.state.completedAt = null;
        entry.state.durationMs = null;
        entry.state.lastResult = null;
        entry.state.lastError = null;

        // Fire-and-forget (like POST /ingest): the slow run continues in the background while we
        // return 202, so the request never sits past Cloudflare's ~100s proxy timeout (#280).
        // Outcome lands on the pipeline state, observable via GET /<name>/status.
        // Capture just the logger — these runs last hours, and closing over `request` would pin
        // its headers/body/raw socket in memory for the whole run; the pino child logger doesn't.
        const log = request.log;
        // Track the detached run so graceful shutdown drains it before closing the driver (#291).
        const enrichRun = prepared
          .run(getDriver())
          .then((summary) => {
            entry.state.lastResult = summary;
            entry.state.completedAt = new Date().toISOString();
            entry.state.durationMs =
              typeof summary['durationMs'] === 'number' ? summary['durationMs'] : null;
          })
          .catch((err: unknown) => {
            entry.state.lastError = err instanceof Error ? err.message : String(err);
            entry.state.completedAt = new Date().toISOString();
            log.error({ err }, `[enrich] ${entry.name} enrichment failed`);
          })
          .finally(() => {
            entry.state.running = false;
          });
        trackBackgroundJob(enrichRun);

        return reply.code(202).send({
          data: {
            message: `${entry.statusLabel} started`,
            statusUrl: `/api/v1/admin/${entry.name}/status`,
          },
        });
      },
    );

    const reset = entry.reset;
    if (reset) {
      fastify.post<{
        Reply: { data: { reset: number } } | { error: { code: string; message: string } };
      }>(
        `/${entry.name}/reset`,
        {
          schema: {
            tags: ['admin'],
            summary: reset.summary,
            description: reset.description,
            security: [{ bearerAuth: [] }],
            response: {
              200: {
                type: 'object',
                required: ['data'],
                properties: {
                  data: {
                    type: 'object',
                    required: ['reset'],
                    properties: { reset: { type: 'integer' } },
                  },
                },
              },
              401: errorResponseRef,
              409: errorResponseRef,
            },
          },
          preHandler: adminAuthHook,
        },
        async (_request, reply) => {
          // Clearing this stage's markers / deleting its relationships mid-reload (or mid-ingest)
          // would make an in-flight stage re-process from scratch (#300). `ignore.enrich` is
          // deliberate: a reset clears only its own stage and contends on no other stage's client,
          // so a concurrent *different* enrich stays allowed — its own pipeline is guarded below.
          const busy = busyWith({ enrich: true });
          if (busy) {
            return reply.code(409).send({ error: busy });
          }
          if (entry.state.running) {
            return reply.code(409).send({
              error: { code: 'ENRICHMENT_RUNNING', message: reset.runningMessage },
            });
          }
          // Every reset holds the running flag so a concurrent /enrich 409s while markers
          // are being cleared (nationality historically skipped this — normalized in #222).
          entry.state.running = true;
          try {
            const count = await reset.run(getDriver());
            return reply.send({ data: { reset: count } });
          } finally {
            entry.state.running = false;
          }
        },
      );
    }
  }

  // ── Status endpoints ───────────────────────────────────────────────────────

  const enrichStatusSchema = (summary: Record<string, unknown>): Record<string, unknown> => ({
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['running', 'startedAt', 'completedAt', 'durationMs', 'lastResult', 'lastError'],
        properties: {
          running: { type: 'boolean' },
          startedAt: { type: 'string', nullable: true },
          completedAt: { type: 'string', nullable: true },
          durationMs: { type: 'number', nullable: true },
          lastResult: { ...summary, nullable: true },
          lastError: { type: 'string', nullable: true },
        },
      },
    },
  });

  for (const entry of PIPELINES) {
    fastify.get(
      `/${entry.name}/status`,
      {
        schema: {
          tags: ['admin'],
          summary: `Status of the most recent ${entry.statusLabel} run`,
          security: [{ bearerAuth: [] }],
          response: { 200: enrichStatusSchema(entry.statusSummarySchema), 401: errorResponseRef },
        },
        preHandler: adminAuthHook,
      },
      async (_request, reply) => reply.send({ data: structuredClone(entry.state) }),
    );
  }

  fastify.post<{
    Reply:
      | { data: { jobId: string; message: string } }
      | { error: { code: string; message: string; jobId?: string } };
  }>(
    '/reload',
    {
      schema: {
        tags: ['admin'],
        summary: 'Trigger the orchestrated reload (ingest + every enrichment) with resume',
        description:
          'Runs the full reload as one resumable, checkpointed job: fetch & MERGE all releases, ' +
          'then **every** enrichment stage in #154 dependency order — including the track-level ' +
          'and nationality stages that `POST /ingest` does NOT run ' +
          '(mb-release-events, track-musicbrainz, track-acousticbrainz, track-deezer, nationality).\n\n' +
          'Per-stage progress is persisted to Neo4j, so if the pod is killed mid-reload the ' +
          'replacement **resumes from the last completed stage on startup** — it does not restart ' +
          'or re-wipe. Poll `GET /api/v1/admin/reload/status` for progress.\n\n' +
          'Runs asynchronously — returns 202 immediately. Returns 409 if a reload is already in ' +
          'progress, or if a standalone `POST /api/v1/admin/<stage>/enrich` is running (they ' +
          'contend on the same rate-limited clients). **Does not wipe**: for a from-scratch reload, ' +
          'call `POST /api/v1/admin/reset?confirm=wipe-all` first, then trigger this.',
        security: [{ bearerAuth: [] }],
        response: {
          202: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['jobId', 'message'],
                properties: { jobId: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
          401: errorResponseRef,
          // Two 409 variants: RELOAD_RUNNING carries the conflicting reload's jobId;
          // ENRICHMENT_RUNNING (a standalone enrich is running, #281) has none — so jobId is
          // optional, not required (fast-json-stringify simply omits it when absent).
          409: {
            type: 'object',
            required: ['error'],
            properties: {
              error: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  jobId: { type: 'string' },
                },
              },
            },
          },
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      const driver = getDriver();

      // Mutual exclusion with the standalone /<stage>/enrich routes (#281) and the /ingest job
      // (#300): a reload contends with both on the same rate-limited clients. Sync, zero-I/O check
      // first, so a busy enrich/ingest short-circuits before the Neo4j round-trip below. (The
      // reverse guards live in the enrich handler via isReloadActive() and in /ingest via
      // busyWith().) `ignore.reload` because another reload is caught by the DB guard just below,
      // which carries the conflicting job's id.
      const busy = busyWith({ reload: true });
      if (busy) {
        return reply.code(409).send({ error: busy });
      }

      // Coarse mutual exclusion against another reload: refuse if a reload job is still running.
      const inProgress = await findResumableReloadJob(driver);
      if (inProgress) {
        return reply.code(409).send({
          error: {
            code: 'RELOAD_RUNNING',
            message: 'A reload is already in progress',
            jobId: inProgress.jobId,
          },
        });
      }

      const username = process.env['DISCOGS_USERNAME'];
      const discogsClient = buildDiscogsClientFromEnv(request.log);
      if (!discogsClient || !username) {
        request.log.warn(
          'POST /reload: DISCOGS_TOKEN or DISCOGS_USERNAME not set — cannot trigger reload',
        );
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Discogs credentials not configured' },
        });
      }

      // Create the job up front so the jobId is known for the 202 and the running job is
      // immediately visible to the 409 guard and to cold-start resume.
      const jobId = await createReloadJob(
        driver,
        RELOAD_STAGES.map((s) => s.name),
      );
      // Flag the reload active *synchronously, before the 202*, so the enrich-side
      // isReloadActive() guard (#281) holds the instant the operator gets their response.
      // runReload sets this too, but only after awaiting job-state reads — leaving a window
      // where an enrich triggered right after this reload would slip through. runReload re-marks
      // it (idempotent) and clears it in its finally on normal completion; the .catch clears it
      // if runReload rejects before reaching that finally, so the flag can't leak.
      markReloadActive(jobId);
      // Track the detached run so graceful shutdown drains it before closing the driver (#291).
      const reloadRun = runReload(driver, {
        username,
        logger: request.log,
        resumeJobId: jobId,
      }).catch((err: unknown) => {
        markReloadInactive(jobId);
        request.log.error({ err }, '[reload] orchestrated reload failed');
        // The orchestration rejected outside any stage's own catch (a transient Neo4j blip in
        // getReloadJob/finishReloadJob/the scheduler), so the job is still `running` in Neo4j and
        // would 409 every future /reload + /reset until a pod restart (#290). Flip it terminal so
        // the operator can retry without a restart. Pass request.log so a zero-match (the job node
        // was deleted out from under us) surfaces the same warning the orchestrator's writes do.
        // Best-effort + fire-and-forget: on failure the prior behaviour stands (stuck `running`,
        // recovered on the next cold-start resume).
        void finishReloadJob(driver, jobId, 'failed', request.log).catch((markErr: unknown) => {
          request.log.error({ err: markErr }, '[reload] failed to mark stuck reload job failed');
        });
      });
      trackBackgroundJob(reloadRun);

      return reply.code(202).send({ data: { jobId, message: 'Reload started' } });
    },
  );

  fastify.get(
    '/reload/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Per-stage status of the most recent orchestrated reload',
        description:
          'Returns the latest reload job with each stage’s status ' +
          '(`pending`/`running`/`complete`/`skipped`/`failed`), counts, and error. ' +
          'While a reload is running, the active stage also carries live `processed`/`total` ' +
          'and a rough `etaMs` (linear extrapolation for that stage only). ' +
          'A running job also carries `ageMs` (its server-computed age) and `stale` (#326): ' +
          '`true` when it is older than `RELOAD_STALE_AFTER_HOURS` (default 12) with no live pod ' +
          'on it — i.e. stuck `running` after a crash/missing-creds cold start and a candidate for ' +
          '`POST /api/v1/admin/reload/abort`. `null` if no reload has ever run.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: reloadJobShape },
          },
          401: errorResponseRef,
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      const driver = getDriver();
      const job = await getLatestReloadJob(driver);
      // Age is computed server-side (getReloadJobAgeMs) rather than from `startedAt` — the stored
      // datetime stringifies to a 9-fractional-digit ISO value that Date.parse handles only by
      // parser leniency. Only fetched for a *running* job — reloadStaleness discards age for a
      // terminal one, so skip the round-trip on the common (latest job already finished) case.
      const ageMs = job?.status === 'running' ? await getReloadJobAgeMs(driver, job.jobId) : null;
      const view = overlayLiveProgress(job, getLiveProgress(), Date.now());
      const staleness = reloadStaleness(job, isReloadActive(), ageMs, resolveStaleAfterMs());
      return reply.send({
        data: view === null ? null : { ...view, ageMs: staleness.ageMs, stale: staleness.stale },
      });
    },
  );

  fastify.post<{
    Reply:
      | { data: { jobId: string; abortedStages: number } }
      | { error: { code: string; message: string } };
  }>(
    '/reload/abort',
    {
      schema: {
        tags: ['admin'],
        summary: 'Force a stuck reload job terminal (operator escape hatch)',
        description:
          'Marks the in-progress reload job (and any of its still-`running` stages) `failed` so it ' +
          'stops 409-blocking `POST /api/v1/admin/reload` and `POST /api/v1/admin/reset` (#326). ' +
          'Use this for a job that is `running` in Neo4j but has **no live pod** executing it — a ' +
          'crash whose recovery never fired, or a cold-start resume skipped because Discogs creds ' +
          'were unset. `GET /api/v1/admin/reload/status` flags such a job with `stale: true`.\n\n' +
          'Returns 404 if no reload job is in progress, and 409 if a reload is **actively running** ' +
          'on this pod (restart the pod to interrupt a live reload — it resumes from its last ' +
          'completed stage; abort only clears a stuck one). Pairs with `/reset`: abort, then wipe.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['jobId', 'abortedStages'],
                properties: {
                  jobId: { type: 'string' },
                  abortedStages: { type: 'integer' },
                },
              },
            },
          },
          401: errorResponseRef,
          404: errorResponseRef,
          409: errorResponseRef,
          503: errorResponseRef,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      const driver = getDriver();
      // Not gated by busyWith(): abort mutates only the ReloadJob/ReloadStage checkpoint nodes, never
      // graph data, and the stuck job it targets is invisible to busyWith (which reads only the
      // in-memory isReloadActive() flag) anyway.
      const resumable = await findResumableReloadJob(driver);
      if (resumable === null) {
        return reply.code(404).send({
          error: { code: 'NO_RELOAD_RUNNING', message: 'No reload job is in progress to abort' },
        });
      }
      // Refuse to abort a reload that is *actively* running on this (single) pod: the in-process
      // scheduler can't be safely interrupted mid-flight, and a concurrent finishReloadJob from the
      // live run would race this. Restarting the pod is the live-interrupt path (#291 leaves the job
      // `running` for resume). Asymmetry vs /reset, which refuses on either signal: abort refuses on
      // the in-memory live signal and *acts* on the DB-only stuck signal.
      if (isReloadActive()) {
        return reply.code(409).send({
          error: {
            code: 'RELOAD_RUNNING',
            message:
              'A reload is actively running — restart the pod to interrupt it; ' +
              'abort only clears a stuck job',
          },
        });
      }
      const abortedStages = await abortReloadJob(driver, resumable.jobId, request.log);
      request.log.warn(
        { jobId: resumable.jobId, abortedStages },
        '[admin] stuck reload job aborted via POST /reload/abort',
      );
      return reply.send({ data: { jobId: resumable.jobId, abortedStages } });
    },
  );
}

export function resetAllPipelineStates(): void {
  for (const entry of PIPELINES) {
    Object.assign(entry.state, makePipelineState());
  }
}

/**
 * Names of the standalone enrichment pipelines currently running — read by the entry point at
 * shutdown to log which detached enrich runs are being drained/interrupted (#291).
 */
export function getRunningPipelineNames(): string[] {
  return PIPELINES.filter((entry) => entry.state.running).map((entry) => entry.name);
}
