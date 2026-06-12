import { type FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { getDriver } from './db/client.js';
import {
  startStatsSnapshots,
  resolveSnapshotIntervalMs,
  ACTIVE_SNAPSHOT_INTERVAL_MS,
} from './observability/stats-snapshot.js';
import { isReloadActive, getLiveProgress } from './ingestion/reload-progress.js';
import { getJobState } from './ingestion/job-state.js';
import { getRunningPipelineNames } from './api/admin.js';
import { requestShutdown, drainBackgroundJobs } from './lifecycle/shutdown.js';
import { summarizeRunningJobs } from './lifecycle/summarize-running-jobs.js';

// How long to wait for detached background jobs (reload / ingest / enrich) to checkpoint-and-exit
// before closing the driver anyway. Comfortably under the 30s k8s terminationGracePeriodSeconds so
// we drain then close cleanly before kubelet SIGKILLs (#291).
const DRAIN_TIMEOUT_MS = 12_000;

const start = async (): Promise<void> => {
  let app: FastifyInstance | undefined;
  let stopSnapshots: (() => void) | null = null;
  let shuttingDown = false;
  try {
    app = await buildServer();
    // Listen port — defaults to 3000, the container port targeted in production
    // (the k8s Service and the deploy health gate both reach the pod on 3000).
    const port = parseInt(process.env['PORT'] ?? '3000', 10);

    // Graceful shutdown (#291): flip the abort signal so the background loops checkpoint-and-exit,
    // log loudly what was running, drain the detached jobs (bounded), THEN stop the snapshot timer
    // and close (the onClose hook closes the Neo4j driver). Closing AFTER the drain is what stops a
    // mid-write loop from throwing "driver closed". Re-entrancy-guarded against a double SIGTERM.
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      requestShutdown();

      const running = summarizeRunningJobs({
        ingestStatus: getJobState().status,
        reloadActive: isReloadActive(),
        reloadProgress: getLiveProgress(),
        runningPipelines: getRunningPipelineNames(),
      });
      if (running) {
        app!.log.warn(
          { runningJobs: running },
          'Shutdown signal received — draining background jobs before closing the Neo4j driver',
        );
      } else {
        app!.log.info('Shutdown signal received — no background jobs running, closing');
      }

      void drainBackgroundJobs(DRAIN_TIMEOUT_MS)
        .then((result) => {
          if (!result.drained) {
            app!.log.warn(
              { pending: result.pending },
              'Background job drain timed out — closing anyway',
            );
          }
          stopSnapshots?.();
          return app!.close();
        })
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
