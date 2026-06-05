import 'dotenv-flow/config';
import Fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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

/**
 * Minimal server for OpenAPI spec generation — registers swagger + routes but
 * skips the onReady DB hook, so it runs without a Neo4j connection.
 * Used by scripts/generate-openapi.ts.
 */
export async function buildDocsServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const autoIngest = options.autoIngest ?? true;
  const app = Fastify({ logger: true });

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
