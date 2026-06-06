import { type FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { getDriver } from './db/client.js';
import {
  startStatsSnapshots,
  resolveSnapshotIntervalMs,
  ACTIVE_SNAPSHOT_INTERVAL_MS,
} from './observability/stats-snapshot.js';
import { isReloadActive } from './ingestion/reload-progress.js';

const start = async (): Promise<void> => {
  let app: FastifyInstance | undefined;
  let stopSnapshots: (() => void) | null = null;
  try {
    app = await buildServer();
    const port = parseInt(process.env['PORT'] ?? '3000', 10);

    // Graceful shutdown — stop the stats-snapshot timer, then close (which fires
    // the onClose hook that closes the Neo4j driver).
    const shutdown = (): void => {
      stopSnapshots?.();
      void app!
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await app.listen({ port, host: '0.0.0.0' });

    // onReady has now run and Neo4j is connected, so begin periodic graph-stats
    // snapshots — structured logs that feed the "Collection over time" dashboard
    // widgets. The interval is unref'd; shutdown stops it explicitly above. While
    // an orchestrated reload runs, the cadence tightens to ACTIVE_SNAPSHOT_INTERVAL_MS
    // so the dashboard's coverage bars move during the reload (#179).
    stopSnapshots = startStatsSnapshots(getDriver(), app.log, resolveSnapshotIntervalMs(), {
      activeIntervalMs: ACTIVE_SNAPSHOT_INTERVAL_MS,
      isActive: isReloadActive,
    });

    if (process.env['NODE_ENV'] !== 'production') {
      const w = 53;
      const pad = (s: string): string => `║  ${s}${' '.repeat(Math.max(0, w - s.length - 2))}║`;
      const lines = [
        `╔${'═'.repeat(w)}╗`,
        pad('liner-notes — dev environment'),
        `╠${'═'.repeat(w)}╣`,
        pad('Graph Service'),
        pad(`  API root:    http://localhost:${port}`),
        pad(`  Health:      http://localhost:${port}/api/v1/health`),
        pad(`  Swagger UI:  http://localhost:${port}/api/docs`),
        pad(`  OpenAPI JSON: http://localhost:${port}/api/docs/json`),
        pad(''),
        pad('Neo4j'),
        pad('  Browser:     http://localhost:7474'),
        pad('  Bolt:        bolt://localhost:7687'),
        `╚${'═'.repeat(w)}╝`,
      ];
      process.stdout.write('\n' + lines.join('\n') + '\n\n');
    }
  } catch (err) {
    console.error(err);
    // Attempt cleanup so the Neo4j driver and any other resources are closed
    // even when startup fails part-way through (e.g. Neo4j unreachable on boot)
    await app?.close().catch(() => undefined);
    process.exit(1);
  }
};

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
