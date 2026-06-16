import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock the repository + driver so the route is tested in isolation.
// ---------------------------------------------------------------------------
const mockGetStats = vi.hoisted(() => vi.fn());
const mockIsReloadActive = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../../src/db/stats-repository.js', () => ({ getStats: mockGetStats }));
vi.mock('../../../src/db/client.js', () => ({ getDriver: vi.fn().mockReturnValue({}) }));
vi.mock('../../../src/ingestion/reload-progress.js', () => ({
  isReloadActive: mockIsReloadActive,
}));

import { statsRoutes } from '../../../src/api/stats.js';

const sourcedNat = {
  covered: 12,
  applicable: 16,
  pct: 75,
  sources: {
    musicbrainz: { covered: 7, applicable: 16, pct: 43.8 },
    wikidata: { covered: 4, applicable: 16, pct: 25 },
    untagged: { covered: 1, applicable: 16, pct: 6.3 },
  },
};

const STATS = {
  counts: {
    releases: 10,
    artists: 20,
    tracks: 100,
    masters: 7,
    musicians: 40,
    works: 50,
    studios: 12,
  },
  enrichment: {
    releasesWithOriginalYear: { covered: 6, applicable: 8, pct: 75 },
    artistsWithProfile: { covered: 12, applicable: 16, pct: 75 },
    artistsWithGenres: { covered: 18, applicable: 18, pct: 100 },
    artistsWithStyles: { covered: 9, applicable: 15, pct: 60 },
    artistsWithWikidataId: { covered: 10, applicable: 16, pct: 62.5 },
    artistsWithBirthDate: { covered: 8, applicable: 16, pct: 50 },
    artistsWithImage: { covered: 5, applicable: 16, pct: 31.3 },
    artistsWithAwards: { covered: 2, applicable: 16, pct: 12.5 },
    artistsWithInstruments: { covered: 4, applicable: 16, pct: 25 },
    artistsWithNationality: sourcedNat,
    musiciansWithNationality: sourcedNat,
    producersWithNationality: sourcedNat,
    engineersWithNationality: sourcedNat,
    tracksWithLyrics: {
      covered: 80,
      applicable: 100,
      pct: 80,
      sources: {
        lrclib: { covered: 70, applicable: 100, pct: 70 },
        genius: { covered: 8, applicable: 100, pct: 8 },
        untagged: { covered: 2, applicable: 100, pct: 2 },
      },
    },
    lyricsFunnel: {
      resolved: 80,
      instrumental: 6,
      probableInstrumental: 4,
      lowConfidence: 5,
      notFound: 5,
      total: 100,
    },
    tracksWithRecordingMbid: { covered: 70, applicable: 100, pct: 70 },
    tracksWithWork: { covered: 42, applicable: 70, pct: 60 },
    tracksWithMbRecordingArtists: { covered: 28, applicable: 70, pct: 40 },
    tracksWithMbProductionCredits: { covered: 14, applicable: 70, pct: 20 },
    tracksWithMbArrangers: { covered: 21, applicable: 70, pct: 30 },
    tracksWithMbStudio: { covered: 7, applicable: 70, pct: 10 },
    studiosWithCoordinates: { covered: 5, applicable: 12, pct: 41.7 },
    worksWithMultipleRecordings: 4,
    worksWithWriterLinks: { covered: 18, applicable: 30, pct: 60 },
    wroteEdges: 22,
    tracksWithIsrc: { covered: 60, applicable: 100, pct: 60 },
    tracksWithTempo: { covered: 35, applicable: 70, pct: 50 },
    tracksWithDeezerBpm: { covered: 30, applicable: 60, pct: 50 },
    tracksWithDeezerGain: { covered: 24, applicable: 60, pct: 40 },
    mastersWithReleaseEvents: { covered: 5, applicable: 7, pct: 71.4 },
    samePersonLinks: { covered: 25, applicable: 25, pct: 100 },
    memberOfEdges: 9,
    groupsWithMembers: 3,
    influencedByEdges: 7,
    // #419 resolution denominator — the full-payload toEqual below also proves the response schema
    // serialises it (a field absent from the schema would be stripped and diverge from STATS).
    influencedByCandidates: 95,
    membershipEdges: 5,
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
    mockIsReloadActive.mockReturnValue(false);
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

  it('shortens the cache TTL to ~5s while a reload is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0); // pin the clock so cache.at starts at a known 0
    try {
      mockGetStats.mockResolvedValue(STATS);
      mockIsReloadActive.mockReturnValue(true);
      const app = await buildApp();
      try {
        await app.inject({ method: 'GET', url: '/api/v1/stats' }); // miss → query #1, cached at t=0
        vi.setSystemTime(3_000);
        await app.inject({ method: 'GET', url: '/api/v1/stats' }); // 3s < 5s → cache hit
        expect(mockGetStats).toHaveBeenCalledTimes(1);
        vi.setSystemTime(6_000);
        await app.inject({ method: 'GET', url: '/api/v1/stats' }); // 6s > 5s → re-query
        expect(mockGetStats).toHaveBeenCalledTimes(2);
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the full 60s TTL when no reload is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0); // pin the clock so cache.at starts at a known 0
    try {
      mockGetStats.mockResolvedValue(STATS);
      mockIsReloadActive.mockReturnValue(false);
      const app = await buildApp();
      try {
        await app.inject({ method: 'GET', url: '/api/v1/stats' }); // miss → query #1, cached at t=0
        vi.setSystemTime(30_000); // 30s — would be a miss under the 5s active TTL
        await app.inject({ method: 'GET', url: '/api/v1/stats' });
        expect(mockGetStats).toHaveBeenCalledTimes(1); // still cached under the 60s idle TTL
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
