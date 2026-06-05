import type { FastifyInstance } from 'fastify';
import type { Driver } from 'neo4j-driver';
import { buildServer } from '../../src/server.js';
import { initDriver } from '../../src/db/client.js';

/**
 * Read a required test-DB connection var (NEO4J_TEST_*), throwing a pointed error
 * if it is unset. There is no NEO4J_* fallback — the test vars must be set
 * explicitly so a missing local config surfaces instead of silently borrowing the
 * app's NEO4J_* values. An explicitly-set empty string is honored (e.g. the empty
 * password of a NEO4J_AUTH=none database), so the check is `=== undefined`, not `!value`.
 */
function resolveTestEnv(testKey: string): string {
  const value = process.env[testKey];
  if (value === undefined) {
    throw new Error(`${testKey} is not set — add it to .env.test.local (see .env.example)`);
  }
  return value;
}

/**
 * Map the required test-DB connection vars (NEO4J_TEST_*) onto the NEO4J_* vars
 * that buildServer's onReady hook and initDriver read, returning the resolved
 * values so callers can initialise a driver without re-reading env.
 *
 * This process.env mutation is safe: the integration suite runs single-threaded
 * (fileParallelism: false), so no other server build observes the change.
 */
function applyTestDbEnv(): { uri: string; user: string; password: string } {
  const uri = resolveTestEnv('NEO4J_TEST_URI');
  const user = resolveTestEnv('NEO4J_TEST_USER');
  const password = resolveTestEnv('NEO4J_TEST_PASSWORD');
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
