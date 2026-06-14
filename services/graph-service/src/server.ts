// Load .env* here, at the top of the module the entrypoint imports first (index.ts → buildServer),
// so env vars are populated before any code runs. This is load-bearing and rests on an invariant:
// NOTHING in src/ reads process.env at module top-level — every env read lives inside a function
// (buildServer, the onReady hook, admin-auth, the build*FromEnv client factories). Keep it that
// way; a new module-level env read elsewhere would observe undefined unless it were imported after
// this line. It stays in server.ts (not index.ts) because tests import buildServer directly, so the
// import must run wherever the server is constructed, not only via the index.ts entrypoint.
import 'dotenv-flow/config';
import Fastify, { FastifyInstance, FastifyServerOptions, FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { healthRoutes } from './api/health.js';
import { adminRoutes } from './api/admin.js';
import { isAuthorizedAdmin } from './api/middleware/admin-auth.js';
import { collectionRoutes } from './api/collection.js';
import { exploreRoutes } from './api/explore.js';
import { searchRoutes } from './api/search.js';
import { statsRoutes } from './api/stats.js';
import { registerSharedSchemas } from './api/schemas.js';
import { registerErrorHandlers } from './api/error-handlers.js';
import { initDriver, closeDriver } from './db/client.js';
import { applySchema } from './db/schema.js';
import { hasReleases } from './db/ingestion-repository.js';
import { buildDiscogsClientFromEnv, runIngestion } from './ingestion/ingest.js';
import { startJob, completeJob, failJob, type IngestionStats } from './ingestion/job-state.js';
import { findResumableReloadJob } from './db/job-repository.js';
import { runReload } from './ingestion/orchestrator.js';
import { trackBackgroundJob } from './lifecycle/shutdown.js';

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
  // Key shared-schema components by their $id (e.g. "ErrorResponse") rather than the
  // default anonymous "def-0"/"def-1", so the generated components.schemas entries and
  // the $refs that point at them are stable and human-readable.
  refResolver: {
    buildLocalReference(
      json: Record<string, unknown>,
      _baseUri: unknown,
      _fragment: string,
      i: number,
    ): string {
      return typeof json['$id'] === 'string' ? json['$id'] : `def-${i}`;
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
 * Resolve whether to key the rate limiter on `cf-connecting-ip`.
 *
 * Precedence: explicit option > TRUST_CF_CONNECTING_IP env > false. Off by default is
 * load-bearing: with it on but no header-overwriting proxy in front, a direct caller
 * could spoof the header per request and bypass the limiter entirely. Local dev and
 * forks not behind such a proxy therefore key on the direct peer (request.ip).
 */
export function resolveTrustCfIp(option?: boolean): boolean {
  if (option !== undefined) return option;
  return process.env['TRUST_CF_CONNECTING_IP'] === 'true';
}

/**
 * Pull a single client IP from a possibly array-valued or comma-joined header, returning
 * the first non-empty token (trimmed) or null when nothing usable is present.
 */
function firstHeaderIp(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0]?.trim();
  return first ? first : null;
}

/**
 * Per-client key for the global rate limiter. When `trustCfIp`, the real client IP comes
 * from Cloudflare's `cf-connecting-ip`; otherwise — and whenever that header is absent or
 * blank — the direct peer `request.ip`.
 */
export function rateLimitKeyGenerator(trustCfIp: boolean): (request: FastifyRequest) => string {
  return (request: FastifyRequest): string => {
    if (trustCfIp) {
      // Cloudflare *overwrites* cf-connecting-ip every request (unlike X-Forwarded-For,
      // which it appends to), so it can't be spoofed past a CF edge — but only the
      // origin's CF-only security group makes that guarantee hold.
      const clientIp = firstHeaderIp(request.headers['cf-connecting-ip']);
      if (clientIp) return clientIp;
    }
    return request.ip;
  };
}

/**
 * Shared rate-limit registration options, so buildServer and buildDocsServer can't drift.
 * Authenticated admin calls are exempt (allowList) so a public flood can't 429 the operator
 * out of the admin surface — a wrong or absent token is NOT exempt and stays limited under
 * its own per-client key (isAuthorizedAdmin returns false unless ADMIN_TOKEN is set and the
 * bearer matches), so admin exemption does not weaken brute-force protection.
 */
function buildRateLimitOptions(
  rateLimitMax?: number,
  trustCfIp = false,
): {
  max: number;
  timeWindow: string;
  keyGenerator: (request: FastifyRequest) => string;
  allowList: (request: FastifyRequest) => boolean;
} {
  return {
    max: resolveRateLimitMax(rateLimitMax),
    timeWindow: RATE_LIMIT_TIME_WINDOW,
    keyGenerator: rateLimitKeyGenerator(trustCfIp),
    allowList: (request: FastifyRequest): boolean => isAuthorizedAdmin(request),
  };
}

/**
 * Minimal server for OpenAPI spec generation — registers swagger + routes but
 * skips the onReady DB hook, so it runs without a Neo4j connection.
 * Used by scripts/generate-openapi.ts.
 */
export async function buildDocsServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSharedSchemas(app);
  await app.register(rateLimit, buildRateLimitOptions());
  await app.register(swagger, OPENAPI_CONFIG);
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'list' },
  });
  registerErrorHandlers(app);
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
   * Key the global rate limiter on Cloudflare's `cf-connecting-ip` header instead of the
   * direct peer (request.ip). Defaults via resolveTrustCfIp (TRUST_CF_CONNECTING_IP env, or
   * false). Tests pass true to exercise per-client bucketing behind a proxy.
   */
  trustCfIp?: boolean;
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

  // Shared response schemas (error + pagination envelopes). Registered before routes
  // so their `$ref`s resolve at route-schema compilation time — and unconditionally
  // (not behind the swagger guard) because routes reference them for runtime
  // serialization whether or not swagger is registered.
  registerSharedSchemas(app);

  // Global rate limiting — a runtime DoS backstop. Registered before routes so its onRequest
  // hook covers every endpoint. Keyed per client IP: behind Cloudflare (live since #119) the
  // direct peer (request.ip) is a CF edge / NodePort-SNAT address shared by ALL public traffic,
  // collapsing the cap into one global bucket — so when TRUST_CF_CONNECTING_IP is set we key on
  // CF's `cf-connecting-ip` header instead (CF overwrites it every request; the origin SG admits
  // only CF ranges, so it's authoritative here). The flag is OFF by default: on without a
  // header-overwriting proxy in front, a direct caller could spoof the header per request and
  // bypass the limiter. Authenticated admin calls are exempt (see buildRateLimitOptions) so a
  // public flood can't 429 the operator out. Note: this does NOT clear the CodeQL
  // js/missing-rate-limiting alerts — that query models only the express-rate-limit family, not
  // @fastify/rate-limit (global hook or per-route config), so its findings here were dismissed as
  // false positives (issue #238).
  await app.register(
    rateLimit,
    buildRateLimitOptions(options.rateLimitMax, resolveTrustCfIp(options.trustCfIp)),
  );

  // Security headers. The default Content-Security-Policy blocks Swagger UI's inline
  // scripts/styles, and swagger is only mounted outside production — so CSP rides the
  // same NODE_ENV switch: full helmet defaults in production, CSP-less elsewhere.
  const isProduction = process.env['NODE_ENV'] === 'production';
  await app.register(helmet, isProduction ? {} : { contentSecurityPolicy: false });

  if (!isProduction) {
    await app.register(swagger, OPENAPI_CONFIG);
    await app.register(swaggerUi, {
      routePrefix: '/api/docs',
      uiConfig: { docExpansion: 'list' },
    });
  }

  // Global error + not-found handlers (issue #288). Must run BEFORE the route
  // plugins: each is an encapsulated child context that inherits the error
  // handler at registration time, so a handler set afterwards wouldn't apply to
  // them. Runs after rate-limit registration — the not-found preHandler uses
  // app.rateLimit().
  registerErrorHandlers(app);

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
      // In production a missing token silently turns every /admin route into a 503 —
      // fail the pod at startup (k8s rollout health gate catches it) instead of
      // shipping an instance whose admin surface can never work.
      if (isProduction) {
        throw new Error('ADMIN_TOKEN must be set in production');
      }
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
        // Track the detached resume so graceful shutdown drains it before closing the driver (#291).
        const resumeRun = runReload(driver, {
          username,
          logger: app.log,
          resumeJobId: resumable.jobId,
        }).catch((err: unknown) => {
          app.log.error({ err }, 'Reload resume failed');
        });
        trackBackgroundJob(resumeRun);
      } else {
        app.log.warn(
          { jobId: resumable.jobId },
          'Interrupted reload detected but DISCOGS_TOKEN or DISCOGS_USERNAME not set — cannot resume',
        );
      }
      return; // do not also run the empty-graph safety net
    }

    // Auto-trigger ingestion when the graph is empty (first run).
    // Fire-and-forget: do NOT await — ingestion takes ~15–17 min for ~200 releases
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
        // Track the detached run so graceful shutdown drains it before closing the driver (#291).
        const ingestRun = runIngestion(discogsClient, driver, { username, logger: app.log })
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
        trackBackgroundJob(ingestRun);
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
