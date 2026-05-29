import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock the repository + driver so the route is tested in isolation.
// ---------------------------------------------------------------------------
const mockGetStats = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/stats-repository.js', () => ({ getStats: mockGetStats }));
vi.mock('../../../src/db/client.js', () => ({ getDriver: vi.fn().mockReturnValue({}) }));

import { statsRoutes } from '../../../src/api/stats.js';

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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(statsRoutes);
  await app.ready();
  return app;
}

describe('GET /api/v1/stats route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stats payload under a data envelope', async () => {
    mockGetStats.mockResolvedValue(STATS);
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ data: STATS });
    } finally {
      await app.close();
    }
  });

  it('coalesces concurrent cache-miss requests into a single getStats call', async () => {
    // Resolve slowly so all concurrent requests arrive while the refresh is in flight.
    mockGetStats.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(STATS), 25)),
    );
    const app = await buildApp();
    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/api/v1/stats' })),
      );
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      // The whole point of the in-flight promise: one query serves all five.
      expect(mockGetStats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('serves subsequent requests from cache without re-querying', async () => {
    mockGetStats.mockResolvedValue(STATS);
    const app = await buildApp();
    try {
      await app.inject({ method: 'GET', url: '/api/v1/stats' });
      await app.inject({ method: 'GET', url: '/api/v1/stats' });
      await app.inject({ method: 'GET', url: '/api/v1/stats' });
      expect(mockGetStats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
