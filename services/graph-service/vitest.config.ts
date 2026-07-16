import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Driver-free suite only. Real-Neo4j integration tests live in tests/integration/**
    // and run via vitest.integration.config.ts so a bare `vitest run` never needs a DB.
    include: ['tests/unit/**/*.test.ts', 'tests/route/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/backup/run.ts', // thin CronJob entrypoint — same rationale as src/index.ts
        'src/ingestion/types.ts', // type declarations only — no executable code
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        // vitest 4.x / vite 6.x v8 counts more branch types (optional chaining,
        // ternaries, nullish coalescing) that v8 in vitest 2.x silently skipped.
        // Equivalent real-world coverage; threshold adjusted to match new counting.
        branches: 65,
        statements: 70,
      },
    },
  },
});
