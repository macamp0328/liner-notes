import type { FastifyInstance } from 'fastify';
import type { Driver } from 'neo4j-driver';
import { buildServer } from '../../src/server.js';
import { initDriver } from '../../src/db/client.js';

/**
 * Resolve a test-DB env var, falling back to its NEO4J_* equivalent.
 * Locally, integration tests run against the docker-compose Neo4j (NEO4J_*);
 * in CI they target the service container via NEO4J_TEST_*.
 */
function resolveTestEnv(testKey: string, fallbackKey: string): string {
  const value = process.env[testKey] ?? process.env[fallbackKey];
  if (!value) {
    throw new Error(`Integration tests require ${testKey} (or ${fallbackKey}) — see .env.example`);
  }
  return value;
}

/**
 * Map the test-DB connection vars (NEO4J_TEST_*, falling back to NEO4J_*) onto the
 * NEO4J_* vars that buildServer's onReady hook and initDriver read, returning the
 * resolved values so callers can initialise a driver without re-reading env.
 *
 * This process.env mutation is safe: the integration suite runs single-threaded
 * (fileParallelism: false), so no other server build observes the change.
 */
function applyTestDbEnv(): { uri: string; user: string; password: string } {
  const uri = resolveTestEnv('NEO4J_TEST_URI', 'NEO4J_URI');
  const user = resolveTestEnv('NEO4J_TEST_USER', 'NEO4J_USER');
  const password = resolveTestEnv('NEO4J_TEST_PASSWORD', 'NEO4J_PASSWORD');
  process.env['NEO4J_URI'] = uri;
  process.env['NEO4J_USER'] = user;
  process.env['NEO4J_PASSWORD'] = password;
  return { uri, user, password };
}

export interface BuildTestServerOptions {
  /**
   * Enable the empty-graph auto-ingestion onReady branch. A test that sets this
   * true MUST (a) pre-clear the graph via initTestDriver() so hasReleases() sees
   * empty, and (b) install its globalThis.fetch spy BEFORE calling buildTestServer,
   * because onReady fires runIngestion fire-and-forget during the app.ready() that
   * happens here. Defaults to false — seeding is otherwise controlled entirely by
   * the fixture loader.
   */
  autoIngest?: boolean;
}

/**
 * Build a Fastify instance wired to the real test Neo4j database and call
 * app.ready() (which runs the onReady DB hook). The test-DB connection details
 * are mapped onto NEO4J_* before the build.
 */
export async function buildTestServer(
  options: BuildTestServerOptions = {},
): Promise<FastifyInstance> {
  applyTestDbEnv();
  const app = await buildServer({ autoIngest: options.autoIngest ?? false });
  await app.ready();
  return app;
}

/**
 * Initialise (or reuse) the shared Neo4j driver against the test DB without
 * building a server, so a test can clear the graph before an autoIngest server's
 * onReady runs hasReleases(). The driver is a process-wide singleton, so the
 * server's own initDriver() call in onReady reuses the instance returned here.
 */
export function initTestDriver(): Driver {
  const { uri, user, password } = applyTestDbEnv();
  return initDriver(uri, user, password);
}
