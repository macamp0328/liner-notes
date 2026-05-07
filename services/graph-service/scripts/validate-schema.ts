/**
 * Schema validation script — used in CI to verify that all Neo4j constraints and
 * indexes can be applied idempotently against a real Neo4j instance.
 *
 * Usage:
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=test \
 *     tsx services/graph-service/scripts/validate-schema.ts
 */
import neo4j from 'neo4j-driver';
import { applySchema } from '../src/db/schema.js';

async function main(): Promise<void> {
  const uri = process.env['NEO4J_URI'];
  const user = process.env['NEO4J_USER'] ?? 'neo4j';
  const password = process.env['NEO4J_PASSWORD'];

  if (!uri || !password) {
    console.error('ERROR: NEO4J_URI and NEO4J_PASSWORD must be set');
    process.exitCode = 1;
    return;
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  try {
    await driver.verifyConnectivity();
    console.log('Neo4j connection verified');

    await applySchema(driver);
    console.log('Schema applied successfully — all constraints and indexes are in place');

    // Run a second time to verify idempotency
    await applySchema(driver);
    console.log('Schema re-applied successfully — idempotency confirmed');
  } catch (err) {
    console.error('Schema validation failed:', err);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
