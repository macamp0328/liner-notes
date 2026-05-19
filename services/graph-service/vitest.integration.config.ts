import { defineConfig } from 'vitest/config';

// Real-Neo4j integration suite. Runs tests/integration/** against a live test
// database (NEO4J_TEST_* — see .env.example). Kept separate from vitest.config.ts
// so the unit/route suites stay driver-free and never need a database.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // The CI neo4j:5 image is Community edition — a single shared database.
    // Test files must not run concurrently against it; each file seeds and
    // clears the graph itself, so they run strictly sequentially.
    fileParallelism: false,
    // Schema application + seeding on a real DB is slower than a mocked unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
