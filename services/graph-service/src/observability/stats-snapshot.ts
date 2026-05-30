import type { Driver } from 'neo4j-driver';
import { getStats } from '../db/stats-repository.js';

/**
 * Minimal structured-logger surface this module needs — satisfied by Fastify's
 * pino instance (`app.log`). Kept narrow so unit tests can pass a plain spy.
 */
export interface SnapshotLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Default cadence: every 6 hours. Frequent enough to trend enrichment coverage
 * within the 30-day CloudWatch log retention, cheap enough to be background
 * noise (four count scans + one log line). Overridable via
 * `STATS_SNAPSHOT_INTERVAL_MS`.
 */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch whole-graph stats and emit them as one structured log line. fluent-bit
 * ships this to CloudWatch, where Logs Insights line charts plot `data.stats.*`
 * over time (collection size, enrichment coverage %).
 *
 * Never throws: a failed snapshot is a missed data point, not an incident, so
 * it logs at `warn` (not `error`) to avoid tripping the ERROR-rate alarm.
 */
export async function logStatsSnapshot(driver: Driver, logger: SnapshotLogger): Promise<void> {
  try {
    const stats = await getStats(driver);
    logger.info({ stats }, 'stats snapshot');
  } catch (err) {
    logger.warn({ err }, 'stats snapshot failed');
  }
}

/**
 * Resolve the snapshot interval from `STATS_SNAPSHOT_INTERVAL_MS`, falling back
 * to the default for an unset, non-numeric, or non-positive value.
 */
export function resolveSnapshotIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['STATS_SNAPSHOT_INTERVAL_MS'];
  if (raw === undefined) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_INTERVAL_MS;
}

/**
 * Emit one snapshot now, then every `intervalMs`. Returns a stop function that
 * cancels the timer. The interval is unref'd so it never keeps the process
 * alive on its own — shutdown still drains cleanly.
 */
export function startStatsSnapshots(
  driver: Driver,
  logger: SnapshotLogger,
  intervalMs: number,
): () => void {
  void logStatsSnapshot(driver, logger);
  const timer = setInterval(() => {
    void logStatsSnapshot(driver, logger);
  }, intervalMs);
  // `unref` exists on Node's Timeout but not on the value some environments
  // (e.g. test fake timers) return — guard it.
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}
