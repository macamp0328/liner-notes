import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Driver } from 'neo4j-driver';

// Mock the repository so the snapshot logic is tested in isolation — no driver.
const mockGetStats = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/stats-repository.js', () => ({ getStats: mockGetStats }));

import {
  logStatsSnapshot,
  resolveSnapshotIntervalMs,
  startStatsSnapshots,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  MAX_SNAPSHOT_INTERVAL_MS,
  AURA_PAUSE_WINDOW_MS,
  ACTIVE_SNAPSHOT_INTERVAL_MS,
} from '../../../src/observability/stats-snapshot.js';

const STATS = {
  counts: { releases: 10, artists: 20, tracks: 100, masters: 7 },
  enrichment: {
    releasesWithOriginalYear: { covered: 6, applicable: 8, pct: 75 },
    artistsWithProfile: { covered: 12, applicable: 16, pct: 75 },
    tracksWithLyrics: { covered: 80, applicable: 100, pct: 80 },
    tracksWithRecordingMbid: { covered: 70, applicable: 100, pct: 70 },
    tracksWithIsrc: { covered: 60, applicable: 100, pct: 60 },
    tracksWithTempo: { covered: 35, applicable: 70, pct: 50 },
    tracksWithDeezerBpm: { covered: 30, applicable: 60, pct: 50 },
  },
};

// getStats is mocked, so the driver is never actually touched.
const driver = {} as Driver;
const makeLogger = () => ({
  info: vi.fn<(obj: object, msg: string) => void>(),
  warn: vi.fn<(obj: object, msg: string) => void>(),
});

describe('logStatsSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs the stats under the "stats snapshot" message on success', async () => {
    mockGetStats.mockResolvedValue(STATS);
    const log = makeLogger();

    await logStatsSnapshot(driver, log);

    expect(log.info).toHaveBeenCalledWith({ stats: STATS }, 'stats snapshot');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a warning (not an error) and never rejects when getStats fails', async () => {
    mockGetStats.mockRejectedValue(new Error('neo4j unavailable'));
    const log = makeLogger();

    await expect(logStatsSnapshot(driver, log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toBe('stats snapshot failed');
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe('resolveSnapshotIntervalMs', () => {
  it('defaults to 6h when the env var is unset', () => {
    expect(resolveSnapshotIntervalMs({})).toBe(DEFAULT_SNAPSHOT_INTERVAL_MS);
    expect(DEFAULT_SNAPSHOT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('parses a positive integer from the env var', () => {
    expect(resolveSnapshotIntervalMs({ STATS_SNAPSHOT_INTERVAL_MS: '60000' })).toBe(60000);
  });

  it('falls back to the default for a non-positive or non-numeric value', () => {
    expect(resolveSnapshotIntervalMs({ STATS_SNAPSHOT_INTERVAL_MS: '0' })).toBe(
      DEFAULT_SNAPSHOT_INTERVAL_MS,
    );
    expect(resolveSnapshotIntervalMs({ STATS_SNAPSHOT_INTERVAL_MS: '-5' })).toBe(
      DEFAULT_SNAPSHOT_INTERVAL_MS,
    );
    expect(resolveSnapshotIntervalMs({ STATS_SNAPSHOT_INTERVAL_MS: 'abc' })).toBe(
      DEFAULT_SNAPSHOT_INTERVAL_MS,
    );
  });

  it('caps an oversized interval at MAX_SNAPSHOT_INTERVAL_MS (24h keep-warm bound)', () => {
    expect(resolveSnapshotIntervalMs({ STATS_SNAPSHOT_INTERVAL_MS: '999999999999' })).toBe(
      MAX_SNAPSHOT_INTERVAL_MS,
    );
    expect(MAX_SNAPSHOT_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  // The snapshot doubles as the Aura keep-warm ping, so its interval must stay
  // under the 72h auto-pause window. Guard the cap so it can't be raised away.
  it('keeps the snapshot/keep-warm cap safely under the 72h Aura auto-pause window', () => {
    expect(MAX_SNAPSHOT_INTERVAL_MS).toBeLessThan(AURA_PAUSE_WINDOW_MS);
    expect(AURA_PAUSE_WINDOW_MS).toBe(72 * 60 * 60 * 1000);
  });
});

describe('startStatsSnapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('emits immediately, then on each interval, until stopped', async () => {
    mockGetStats.mockResolvedValue(STATS);
    const log = makeLogger();

    const stop = startStatsSnapshots(driver, log, 1000);

    await vi.advanceTimersByTimeAsync(0); // flush the immediate emit's microtasks
    expect(log.info).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(log.info).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000); // two more ticks
    expect(log.info).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(5000); // nothing after the timer is cleared
    expect(log.info).toHaveBeenCalledTimes(4);
  });
});

describe('startStatsSnapshots — reload-aware cadence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  // Shortening while active only ever tightens the keep-warm window, never relaxes it.
  it('uses an active interval safely under the keep-warm cap', () => {
    expect(ACTIVE_SNAPSHOT_INTERVAL_MS).toBeLessThan(MAX_SNAPSHOT_INTERVAL_MS);
    expect(ACTIVE_SNAPSHOT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('emits on the active cadence while active and the idle cadence otherwise', async () => {
    mockGetStats.mockResolvedValue(STATS);
    const log = makeLogger();
    let active = false;

    const stop = startStatsSnapshots(driver, log, 60_000, {
      activeIntervalMs: 1_000,
      isActive: () => active,
    });

    await vi.advanceTimersByTimeAsync(0); // immediate emit
    expect(log.info).toHaveBeenCalledTimes(1);

    // Idle: the short tick fires, but nothing is due until 60s elapse.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(log.info).toHaveBeenCalledTimes(1);

    // A reload starts mid-interval — the very next short tick is due (>1s elapsed) and emits,
    // i.e. it does not wait out the remaining idle interval.
    active = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.info).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000); // two more active ticks → two more emits
    expect(log.info).toHaveBeenCalledTimes(4);

    // Reload ends — back to the 60s gate, short ticks stop emitting.
    active = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.info).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(10_000); // nothing after stop
    expect(log.info).toHaveBeenCalledTimes(4);
  });
});
