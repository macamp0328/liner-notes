import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetReleasesByMusician = vi.hoisted(() => vi.fn());
const mockGetReleasesByCredit = vi.hoisted(() => vi.fn());
const mockGetReleasesByStudio = vi.hoisted(() => vi.fn());
const mockGetReleasesByLabel = vi.hoisted(() => vi.fn());
const mockGetReleasesByGenre = vi.hoisted(() => vi.fn());
const mockGetReleasesByStyle = vi.hoisted(() => vi.fn());
const mockGetReleasesByCountry = vi.hoisted(() => vi.fn());
const mockGetReleasesByDecade = vi.hoisted(() => vi.fn());
const mockGetReleasesByYear = vi.hoisted(() => vi.fn());
const mockGetConnections = vi.hoisted(() => vi.fn());
const mockGetSharedMusicians = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repositories/explore-repository.js', () => ({
  getReleasesByMusician: mockGetReleasesByMusician,
  getReleasesByCredit: mockGetReleasesByCredit,
  getReleasesByStudio: mockGetReleasesByStudio,
  getReleasesByLabel: mockGetReleasesByLabel,
  getReleasesByGenre: mockGetReleasesByGenre,
  getReleasesByStyle: mockGetReleasesByStyle,
  getReleasesByCountry: mockGetReleasesByCountry,
  getReleasesByDecade: mockGetReleasesByDecade,
  getReleasesByYear: mockGetReleasesByYear,
  getConnections: mockGetConnections,
  getSharedMusicians: mockGetSharedMusicians,
}));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const sampleRelease = {
  discogsId: 13570466,
  title: 'U.F.O.F.',
  artist: 'Big Thief',
  pressingYear: 2019,
  format: 'Vinyl',
  thumbUrl: null,
};

const sampleMusicianRelease = {
  ...sampleRelease,
  instrument: 'Guitar',
  role: 'performer',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('explore routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // GET /api/v1/explore/musician/:name
  describe('GET /api/v1/explore/musician/:name', () => {
    it('returns 200 with musician releases', async () => {
      mockGetReleasesByMusician.mockResolvedValue([sampleMusicianRelease]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/John+Coltrane',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleMusicianRelease)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.instrument).toBe('Guitar');
      expect(body[0]!.role).toBe('performer');
    });

    it('returns 200 with empty array when no results', async () => {
      mockGetReleasesByMusician.mockResolvedValue([]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/musician/Unknown' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  // GET /api/v1/explore/producer/:name
  describe('GET /api/v1/explore/producer/:name', () => {
    it('returns 200 and queries the producer role category', async () => {
      mockGetReleasesByCredit.mockResolvedValue([{ ...sampleMusicianRelease, role: 'producer' }]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/producer/Andrew%20Sarlo',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleMusicianRelease)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.role).toBe('producer');
      expect(mockGetReleasesByCredit).toHaveBeenCalledWith(
        expect.anything(),
        'Andrew Sarlo',
        'producer',
      );
    });
  });

  // GET /api/v1/explore/engineer/:name
  describe('GET /api/v1/explore/engineer/:name', () => {
    it('returns 200 and queries the engineer role category', async () => {
      mockGetReleasesByCredit.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/engineer/Dominic%20Monks',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
      expect(mockGetReleasesByCredit).toHaveBeenCalledWith(
        expect.anything(),
        'Dominic Monks',
        'engineer',
      );
    });
  });

  // GET /api/v1/explore/studio/:name
  describe('GET /api/v1/explore/studio/:name', () => {
    it('returns 200 with studio releases', async () => {
      mockGetReleasesByStudio.mockResolvedValue([sampleRelease]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/studio/Capitol+Studios',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.title).toBe('U.F.O.F.');
    });
  });

  // GET /api/v1/explore/label/:name
  describe('GET /api/v1/explore/label/:name', () => {
    it('returns 200 with label releases', async () => {
      mockGetReleasesByLabel.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/label/4AD' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });
  });

  // GET /api/v1/explore/genre/:name
  describe('GET /api/v1/explore/genre/:name', () => {
    it('returns 200 with genre releases', async () => {
      mockGetReleasesByGenre.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/genre/Jazz' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });
  });

  // GET /api/v1/explore/style/:name
  describe('GET /api/v1/explore/style/:name', () => {
    it('returns 200 with style releases', async () => {
      mockGetReleasesByStyle.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/style/Hard+Bop' });
      expect(response.statusCode).toBe(200);
    });
  });

  // GET /api/v1/explore/country/:name
  describe('GET /api/v1/explore/country/:name', () => {
    it('returns 200 with country releases', async () => {
      mockGetReleasesByCountry.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/country/US' });
      expect(response.statusCode).toBe(200);
    });
  });

  // GET /api/v1/explore/decade/:decade
  describe('GET /api/v1/explore/decade/:decade', () => {
    it('returns 200 for valid decade format', async () => {
      mockGetReleasesByDecade.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/2010s' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });

    it('returns 400 for invalid decade format (no trailing s)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/2010' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_DECADE');
    });

    it('returns 400 for invalid decade format (non-numeric)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/197Xs' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_DECADE');
    });

    it('returns 400 for non-decade-boundary year (e.g. 1975s)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/1975s' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_DECADE');
    });
  });

  // GET /api/v1/explore/year/:year
  describe('GET /api/v1/explore/year/:year', () => {
    it('returns 200 for valid year', async () => {
      mockGetReleasesByYear.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/year/2019' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });

    it('returns 400 for non-integer year', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/year/notayear' });
      expect(response.statusCode).toBe(400);
    });
  });

  // GET /api/v1/explore/connections/:discogsId
  describe('GET /api/v1/explore/connections/:discogsId', () => {
    it('returns 200 with graph connections at default depth 2', async () => {
      mockGetConnections.mockResolvedValue({
        seed: sampleRelease,
        nodes: [{ type: 'Musician', discogsId: null, name: 'John Smith', title: null }],
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/13570466',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        seed: typeof sampleRelease;
        nodes: unknown[];
      };
      expect(body.seed.discogsId).toBe(13570466);
      expect(body.nodes).toHaveLength(1);
    });

    it('returns 200 with explicit depth param', async () => {
      mockGetConnections.mockResolvedValue({ seed: sampleRelease, nodes: [] });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/13570466?depth=1',
      });
      expect(response.statusCode).toBe(200);
      expect(mockGetConnections).toHaveBeenCalledWith(expect.anything(), 13570466, 1);
    });

    it('returns 404 when release not found', async () => {
      mockGetConnections.mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/99999',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when depth exceeds 3', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/13570466?depth=4',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // GET /api/v1/explore/shared-musicians
  describe('GET /api/v1/explore/shared-musicians', () => {
    it('returns 200 with release pairs', async () => {
      mockGetSharedMusicians.mockResolvedValue([
        {
          releaseA: { discogsId: 13570466, title: 'U.F.O.F.' },
          releaseB: { discogsId: 9999991, title: 'Other Album' },
          sharedMusicians: [{ name: 'John Smith', instrument: 'Guitar' }],
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/shared-musicians',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { sharedMusicians: unknown[] }[];
      expect(body).toHaveLength(1);
      expect(body[0]!.sharedMusicians).toHaveLength(1);
    });

    it('returns 200 with empty array when no pairs', async () => {
      mockGetSharedMusicians.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/shared-musicians',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });
});
