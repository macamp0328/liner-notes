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

  it('caps an oversized interval at the 32-bit max (Node setInterval overflow guard)', () => {
    expect(resolveSnapshotIntervalMs({ STATS_SNAPSHOT_INTERVAL_MS: '999999999999' })).toBe(
      MAX_SNAPSHOT_INTERVAL_MS,
    );
    expect(MAX_SNAPSHOT_INTERVAL_MS).toBe(2_147_483_647);
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
