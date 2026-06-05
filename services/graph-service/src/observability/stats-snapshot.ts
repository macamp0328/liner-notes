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
 * `STATS_SNAPSHOT_INTERVAL_MS`. Doubles as the Aura keep-warm cadence — see
 * `logStatsSnapshot` and `MAX_SNAPSHOT_INTERVAL_MS`.
 */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * AuraDB Free auto-pauses after 72h of inactivity, and only a *real query* (not
 * a connectivity check) resets that idle timer. Each snapshot runs real Cypher
 * (`getStats`), so the snapshot timer is also our Aura keep-warm ping — see
 * `logStatsSnapshot`. This constant is the hard window the snapshot interval
 * must stay under, asserted in the unit tests so the keep-warm guarantee can't
 * be silently raised away. See infra/RUNBOOK.md "Keeping Aura warm".
 */
export const AURA_PAUSE_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Upper bound on the snapshot interval. Because the snapshot doubles as the Aura
 * keep-warm ping (see `AURA_PAUSE_WINDOW_MS`), the binding constraint is the 72h
 * auto-pause window, not Node's `setInterval` overflow: 24h leaves ≥3 keep-warm
 * pings per window while still allowing a daily-cadence snapshot to cut log
 * volume, and is trivially under the 32-bit-max overflow point. `resolveSnapshot
 * IntervalMs` clamps to this, so `STATS_SNAPSHOT_INTERVAL_MS` can never push the
 * keep-warm out past the pause window. The default stays 6h.
 */
export const MAX_SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch whole-graph stats and emit them as one structured log line. fluent-bit
 * ships this to CloudWatch, where Logs Insights bar charts plot `data.stats.*`
 * over time (collection size, enrichment coverage %). Bars, not lines: these
 * snapshots are sparse (6h cadence on a scale-to-zero host), and a line widget
 * errors on a window with fewer than two points.
 *
 * Doubles as the Aura keep-warm ping: `getStats` runs real Cypher, which is what
 * resets AuraDB Free's 72h auto-pause timer (a connectivity check does not). The
 * timer rides the graph-service pod, so it keeps Aura warm exactly while the k3s
 * node is up — when the node is intentionally stopped (`power:off`) past 72h,
 * Aura pauses by design. See infra/RUNBOOK.md "Keeping Aura warm".
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
 * to the default for an unset, non-numeric, or non-positive value, and clamping
 * to MAX_SNAPSHOT_INTERVAL_MS so an oversized value can't trip Node's
 * setInterval overflow (delays past the 32-bit max are clamped to 1ms).
 */
export function resolveSnapshotIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['STATS_SNAPSHOT_INTERVAL_MS'];
  if (raw === undefined) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SNAPSHOT_INTERVAL_MS;
  return Math.min(parsed, MAX_SNAPSHOT_INTERVAL_MS);
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
