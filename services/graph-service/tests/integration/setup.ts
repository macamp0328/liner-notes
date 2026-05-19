import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

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
 * Build a Fastify instance wired to the real test Neo4j database.
 *
 * buildServer's onReady hook reads NEO4J_URI/USER/PASSWORD, so the test-DB
 * connection details are mapped onto those variables before the build. This
 * process.env mutation is safe: the integration suite runs single-threaded
 * (fileParallelism: false), so no other server build observes the change.
 *
 * autoIngest is disabled — seeding is controlled entirely by the fixture loader.
 */
export async function buildTestServer(): Promise<FastifyInstance> {
  process.env['NEO4J_URI'] = resolveTestEnv('NEO4J_TEST_URI', 'NEO4J_URI');
  process.env['NEO4J_USER'] = resolveTestEnv('NEO4J_TEST_USER', 'NEO4J_USER');
  process.env['NEO4J_PASSWORD'] = resolveTestEnv('NEO4J_TEST_PASSWORD', 'NEO4J_PASSWORD');

  const app = await buildServer({ autoIngest: false });
  await app.ready();
  return app;
}
