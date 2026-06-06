import 'dotenv-flow/config';
import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { healthRoutes } from './api/health.js';
import { adminRoutes } from './api/admin.js';
import { collectionRoutes } from './api/collection.js';
import { exploreRoutes } from './api/explore.js';
import { searchRoutes } from './api/search.js';
import { statsRoutes } from './api/stats.js';
import { initDriver, closeDriver } from './db/client.js';
import { applySchema } from './db/schema.js';
import { hasReleases } from './db/ingestion-repository.js';
import { buildDiscogsClientFromEnv, runIngestion } from './ingestion/ingest.js';
import { startJob, completeJob, failJob, type IngestionStats } from './ingestion/job-state.js';
import { findResumableReloadJob } from './db/job-repository.js';
import { runReload } from './ingestion/orchestrator.js';

const OPENAPI_CONFIG = {
  openapi: {
    info: {
      title: 'liner-notes API',
      description: 'Graph-driven vinyl record collection explorer',
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'ops', description: 'Health and admin operations' },
      { name: 'admin', description: 'Ingestion control and operational status' },
      { name: 'collection', description: 'Release, artist, and label queries' },
      { name: 'explore', description: 'Relationship traversal endpoints' },
      { name: 'search', description: 'Full-text search' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http' as const, scheme: 'bearer' },
      },
    },
  },
};

const DEFAULT_RATE_LIMIT_MAX = 100;
const RATE_LIMIT_TIME_WINDOW = '1 minute';

/**
 * Resolve the per-IP request cap for the global rate limiter.
 *
 * Precedence: explicit option > test bypass > RATE_LIMIT_MAX env > default. The
 * whole suite runs with NODE_ENV=test, where an unbounded cap keeps multi-request
 * test files from throttling themselves; pass an explicit `rateLimitMax` to exercise
 * throttling. A non-positive or unparseable env value falls back to the default.
 */
export function resolveRateLimitMax(option?: number): number {
  if (option !== undefined) return option;
  if (process.env['NODE_ENV'] === 'test') return Number.MAX_SAFE_INTEGER;
  const fromEnv = Number.parseInt(process.env['RATE_LIMIT_MAX'] ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RATE_LIMIT_MAX;
}

/**
 * Minimal server for OpenAPI spec generation — registers swagger + routes but
 * skips the onReady DB hook, so it runs without a Neo4j connection.
 * Used by scripts/generate-openapi.ts.
 */
export async function buildDocsServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: resolveRateLimitMax(), timeWindow: RATE_LIMIT_TIME_WINDOW });
  await app.register(swagger, OPENAPI_CONFIG);
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'list' },
  });
  await app.register(healthRoutes);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(collectionRoutes);
  await app.register(exploreRoutes);
  await app.register(searchRoutes);
  await app.register(statsRoutes);
  return app;
}

export interface BuildServerOptions {
  /**
   * When false, the onReady hook still connects to Neo4j and applies the schema
   * but skips the empty-graph auto-ingestion check. Integration tests set this
   * so seeding is fully controlled by the fixture loader. Defaults to true.
   */
  autoIngest?: boolean;
  /**
   * Per-IP request cap for the global rate limiter. Defaults via resolveRateLimitMax
   * (RATE_LIMIT_MAX env, or 100; unbounded under NODE_ENV=test). Tests pass a small
   * value to assert throttling.
   */
  rateLimitMax?: number;
  /**
   * Fastify logger configuration. Mirrors Fastify's own `logger` option type
   * (boolean | a logger instance | pino options) so callers get proper TS
   * validation/autocomplete. Defaults to true unless NODE_ENV=test.
   */
  logger?: FastifyServerOptions['logger'];
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const autoIngest = options.autoIngest ?? true;
  const enableLogger = options.logger ?? process.env['NODE_ENV'] !== 'test';
  const app = Fastify({ logger: enableLogger });

  // Global rate limiting — a runtime DoS backstop. Registered before routes so its onRequest
  // hook covers every endpoint. The cap is per client IP (request.ip) — note that behind a
  // proxy/NodePort that SNATs the source address, callers can share a bucket unless Fastify
  // `trustProxy` + X-Forwarded-For are configured; the planned Cloudflare layer is the primary
  // edge defence. Note: this does NOT clear the CodeQL js/missing-rate-limiting alerts — that
  // query models only the express-rate-limit family, not @fastify/rate-limit (global hook or
  // per-route config), so its findings here were dismissed as false positives (issue #238).
  await app.register(rateLimit, {
    max: resolveRateLimitMax(options.rateLimitMax),
    timeWindow: RATE_LIMIT_TIME_WINDOW,
  });

  if (process.env['NODE_ENV'] !== 'production') {
    await app.register(swagger, OPENAPI_CONFIG);
    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      uiConfig: { docExpansion: 'list' },
    });
  }

  await app.register(healthRoutes);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(collectionRoutes);
  await app.register(exploreRoutes);
  await app.register(searchRoutes);
  await app.register(statsRoutes);

  app.addHook('onReady', async () => {
    const uri = process.env['NEO4J_URI'];
    const user = process.env['NEO4J_USER'];
    const password = process.env['NEO4J_PASSWORD'];

    // Require each var to be *set*, but honor an explicitly-empty value: an empty
    // password is legitimate for a NEO4J_AUTH=none database (local docker-compose).
    // `=== undefined` (not `!value`) lets "" through while a genuinely unset var
    // still fails fast here instead of surfacing later as an opaque driver error.
    if (uri === undefined || user === undefined || password === undefined) {
      throw new Error('NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD must be set');
    }

    if (!process.env['ADMIN_TOKEN']) {
      app.log.warn('ADMIN_TOKEN not set — admin endpoints will return 503');
    }

    const driver = initDriver(uri, user, password);
    await driver.verifyConnectivity();
    app.log.info('Neo4j connected');
    await applySchema(driver);
    app.log.info('Neo4j schema applied');

    if (!autoIngest) {
      app.log.info('Auto-ingestion disabled — skipping empty-graph check');
      return;
    }

    // Cold-start recovery (issue #175): if a reload was interrupted — its job is still
    // `running` because the pod died before it finished — resume it from the last completed
    // stage. This is what makes a deploy/pod-roll mid-reload safe: the persisted job is the
    // source of truth, so the replacement pod continues rather than skipping (the graph is
    // non-empty) or re-wiping. Fire-and-forget — must not block onReady.
    const resumable = await findResumableReloadJob(driver);
    if (resumable) {
      const username = process.env['DISCOGS_USERNAME'];
      // Guard on Discogs creds the same way the empty-graph path does: without a usable
      // client the `releases` stage (and other Discogs stages) would resolve to `skipped`
      // and the job could finish without ever ingesting. Better to leave it `running` and
      // resume once creds are present than to silently complete an empty reload.
      const discogsClient = buildDiscogsClientFromEnv(app.log);
      if (discogsClient && username) {
        app.log.warn(
          { jobId: resumable.jobId },
          'Interrupted reload detected — resuming from the last completed stage',
        );
        void runReload(driver, { username, logger: app.log, resumeJobId: resumable.jobId }).catch(
          (err: unknown) => {
            app.log.error({ err }, 'Reload resume failed');
          },
        );
      } else {
        app.log.warn(
          { jobId: resumable.jobId },
          'Interrupted reload detected but DISCOGS_TOKEN or DISCOGS_USERNAME not set — cannot resume',
        );
      }
      return; // do not also run the empty-graph safety net
    }

    // Auto-trigger ingestion when the graph is empty (first run).
    // Fire-and-forget: do NOT await — ingestion takes ~4 min for 200 releases
    // and must not block onReady (which would delay the health endpoint and
    // cause container health checks to fail during startup).
    const empty = !(await hasReleases(driver));
    if (empty) {
      const username = process.env['DISCOGS_USERNAME'];
      // buildDiscogsClientFromEnv handles delay validation; no separate parsing needed here.
      // Pass app.log so 429 warnings from DiscogsClient go through the structured pino logger.
      const discogsClient = buildDiscogsClientFromEnv(app.log);

      if (discogsClient && username) {
        app.log.info('Graph is empty — starting Discogs ingestion in background');
        startJob();
        void runIngestion(discogsClient, driver, { username, logger: app.log })
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
            app.log.info({ summary }, 'Discogs ingestion complete');
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            failJob(msg);
            app.log.error({ err }, 'Discogs ingestion failed');
          });
      } else {
        app.log.warn(
          'Graph is empty but DISCOGS_TOKEN or DISCOGS_USERNAME not set — skipping auto-ingestion',
        );
      }
    } else {
      app.log.info('Graph already populated — skipping auto-ingestion');
    }
  });

  app.addHook('onClose', async () => {
    await closeDriver();
  });

  return app;
}
