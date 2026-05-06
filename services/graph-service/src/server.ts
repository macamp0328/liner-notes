import 'dotenv-flow/config';
import Fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { healthRoutes } from './api/health.js';
import { initDriver, closeDriver } from './db/client.js';
import { applySchema } from './db/schema.js';
import { hasReleases } from './db/ingestion-repository.js';
import { buildDiscogsClientFromEnv, runIngestion } from './ingestion/ingest.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'liner-notes API',
        description: 'Graph-driven vinyl record collection explorer',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:3000' }],
      tags: [
        { name: 'ops', description: 'Health and admin operations' },
        { name: 'collection', description: 'Release, artist, and label queries' },
        { name: 'explore', description: 'Relationship traversal endpoints' },
        { name: 'search', description: 'Full-text search' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'list' },
  });

  await app.register(healthRoutes);

  app.addHook('onReady', async () => {
    const uri = process.env['NEO4J_URI'];
    const user = process.env['NEO4J_USER'];
    const password = process.env['NEO4J_PASSWORD'];

    if (!uri || !user || !password) {
      throw new Error('NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD are required');
    }

    const driver = initDriver(uri, user, password);
    await driver.verifyConnectivity();
    app.log.info('Neo4j connected');
    await applySchema(driver);
    app.log.info('Neo4j schema applied');

    // Auto-trigger ingestion when the graph is empty (first run).
    // Fire-and-forget: do NOT await — ingestion takes ~4 min for 200 releases
    // and must not block onReady (which would delay the health endpoint and
    // cause container health checks to fail during startup).
    const empty = !(await hasReleases(driver));
    if (empty) {
      const username = process.env['DISCOGS_USERNAME'];
      // buildDiscogsClientFromEnv handles delay validation; no separate parsing needed here.
      const discogsClient = buildDiscogsClientFromEnv();

      if (discogsClient && username) {
        app.log.info('Graph is empty — starting Discogs ingestion in background');
        void runIngestion(discogsClient, driver, { username, logger: app.log })
          .then((summary) => {
            app.log.info({ summary }, 'Discogs ingestion complete');
          })
          .catch((err: unknown) => {
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
