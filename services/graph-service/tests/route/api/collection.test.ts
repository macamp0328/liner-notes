import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import type {
  ReleaseListItem,
  ReleaseFull,
  ArtistFull,
  LabelFull,
} from '../../../src/db/repositories/collection-repository.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before vi.mock() calls
// ---------------------------------------------------------------------------

const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockListReleases = vi.hoisted(() => vi.fn());
const mockGetReleaseById = vi.hoisted(() => vi.fn());
const mockGetArtistById = vi.hoisted(() => vi.fn());
const mockGetLabelById = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/job-repository.js', () => ({
  findResumableReloadJob: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repositories/collection-repository.js', () => ({
  listReleases: mockListReleases,
  getReleaseById: mockGetReleaseById,
  getArtistById: mockGetArtistById,
  getLabelById: mockGetLabelById,
}));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const sampleListItem: ReleaseListItem = {
  discogsId: 13570466,
  title: 'U.F.O.F.',
  pressingYear: 2019,
  format: 'Vinyl',
  thumbUrl: 'https://example.com/thumb.jpg',
  artistName: 'Big Thief',
  labelName: '4AD',
};

const sampleReleaseFull: ReleaseFull = {
  discogsId: 13570466,
  title: 'U.F.O.F.',
  pressingYear: 2019,
  format: 'Vinyl',
  thumbUrl: 'https://example.com/thumb.jpg',
  artistName: 'Big Thief',
  labelName: '4AD',
  masterDiscogsId: 1234,
  originalYear: 2019,
  releaseDate: '2019-05-03',
  notes: null,
  discogsUrl: 'https://www.discogs.com/release/13570466',
  communityRating: 4.5,
  communityRatingCount: 10,
  barcode: null,
  artists: [{ discogsId: 5009441, name: 'Big Thief', role: '' }],
  labels: [{ discogsId: 634, name: '4AD', catalogNumber: '4AD0129LP' }],
  genres: ['Rock'],
  styles: ['Indie Rock'],
  country: 'US',
  studios: ['Bear Creek Studios'],
  tracks: [
    {
      position: 'A1',
      title: 'Contact',
      duration: '4:02',
      lyrics: null,
      lyricsSource: null,
      musicians: [],
      tempo: null,
      musicalKey: null,
      musicalScale: null,
      loudnessDb: null,
      danceabilityEstimate: null,
      voiceInstrumental: null,
      deezerBpm: null,
      deezerGain: null,
    },
  ],
  credits: [],
};

const sampleArtistFull: ArtistFull = {
  discogsId: 5009441,
  name: 'Big Thief',
  realName: null,
  profile: 'American indie rock band',
  releases: [
    {
      discogsId: 13570466,
      title: 'U.F.O.F.',
      pressingYear: 2019,
      format: 'Vinyl',
      thumbUrl: null,
      role: '',
    },
  ],
  credits: [],
};

const sampleLabelFull: LabelFull = {
  discogsId: 634,
  name: '4AD',
  profile: 'UK independent record label',
  contactInfo: null,
  releases: [
    {
      discogsId: 13570466,
      title: 'U.F.O.F.',
      pressingYear: 2019,
      format: 'Vinyl',
      thumbUrl: null,
      catalogNumber: '4AD0129LP',
      artistName: 'Big Thief',
    },
  ],
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('Collection API routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    mockVerifyConnectivity.mockResolvedValue(undefined);
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/releases
  // -------------------------------------------------------------------------

  describe('GET /api/v1/releases', () => {
    it('returns 200 with paginated releases using defaults', async () => {
      mockListReleases.mockResolvedValue({ items: [sampleListItem], total: 42 });

      const response = await app.inject({ method: 'GET', url: '/api/v1/releases' });
      const body = JSON.parse(response.payload) as {
        data: ReleaseListItem[];
        pagination: { page: number; limit: number; total: number; totalPages: number };
      };

      expect(response.statusCode).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ discogsId: 13570466, title: 'U.F.O.F.' });
      expect(body.pagination).toMatchObject({ page: 1, limit: 20, total: 42, totalPages: 3 });
    });

    it('computes pagination correctly for explicit page and limit', async () => {
      mockListReleases.mockResolvedValue({ items: [], total: 100 });

      const response = await app.inject({ method: 'GET', url: '/api/v1/releases?page=3&limit=10' });
      const body = JSON.parse(response.payload) as {
        pagination: { page: number; limit: number; totalPages: number };
      };

      expect(response.statusCode).toBe(200);
      expect(body.pagination).toMatchObject({ page: 3, limit: 10, total: 100, totalPages: 10 });
      expect(mockListReleases).toHaveBeenCalledWith(expect.anything(), 20, 10);
    });

    it('returns 400 when limit exceeds maximum', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/releases?limit=999' });
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when page is below minimum', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/releases?page=0' });
      expect(response.statusCode).toBe(400);
    });

    it('returns empty data with zero total and totalPages when collection is empty', async () => {
      mockListReleases.mockResolvedValue({ items: [], total: 0 });

      const response = await app.inject({ method: 'GET', url: '/api/v1/releases' });
      const body = JSON.parse(response.payload) as {
        data: unknown[];
        pagination: { total: number; totalPages: number };
      };

      expect(response.statusCode).toBe(200);
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.pagination.totalPages).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/releases/:discogsId
  // -------------------------------------------------------------------------

  describe('GET /api/v1/releases/:discogsId', () => {
    it('returns 200 with full release data', async () => {
      mockGetReleaseById.mockResolvedValue(sampleReleaseFull);

      const response = await app.inject({ method: 'GET', url: '/api/v1/releases/13570466' });
      const body = JSON.parse(response.payload) as { data: ReleaseFull };

      expect(response.statusCode).toBe(200);
      expect(body.data.discogsId).toBe(13570466);
      expect(body.data.artists).toHaveLength(1);
      expect(body.data.tracks).toHaveLength(1);
    });

    it('returns 404 when release not found', async () => {
      mockGetReleaseById.mockResolvedValue(null);

      const response = await app.inject({ method: 'GET', url: '/api/v1/releases/999' });
      const body = JSON.parse(response.payload) as { error: { code: string } };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when discogsId is not an integer', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/releases/not-an-id' });
      expect(response.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/artists/:discogsId
  // -------------------------------------------------------------------------

  describe('GET /api/v1/artists/:discogsId', () => {
    it('returns 200 with artist data including releases and credits', async () => {
      mockGetArtistById.mockResolvedValue(sampleArtistFull);

      const response = await app.inject({ method: 'GET', url: '/api/v1/artists/5009441' });
      const body = JSON.parse(response.payload) as { data: ArtistFull };

      expect(response.statusCode).toBe(200);
      expect(body.data.discogsId).toBe(5009441);
      expect(body.data.name).toBe('Big Thief');
      expect(body.data.releases).toHaveLength(1);
      expect(body.data.credits).toEqual([]);
    });

    it('returns 404 when artist not found', async () => {
      mockGetArtistById.mockResolvedValue(null);

      const response = await app.inject({ method: 'GET', url: '/api/v1/artists/999' });
      const body = JSON.parse(response.payload) as { error: { code: string } };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when discogsId is not an integer', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/artists/invalid' });
      expect(response.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/labels/:discogsId
  // -------------------------------------------------------------------------

  describe('GET /api/v1/labels/:discogsId', () => {
    it('returns 200 with label data and releases', async () => {
      mockGetLabelById.mockResolvedValue(sampleLabelFull);

      const response = await app.inject({ method: 'GET', url: '/api/v1/labels/634' });
      const body = JSON.parse(response.payload) as { data: LabelFull };

      expect(response.statusCode).toBe(200);
      expect(body.data.discogsId).toBe(634);
      expect(body.data.name).toBe('4AD');
      expect(body.data.releases).toHaveLength(1);
    });

    it('returns 404 when label not found', async () => {
      mockGetLabelById.mockResolvedValue(null);

      const response = await app.inject({ method: 'GET', url: '/api/v1/labels/999' });
      const body = JSON.parse(response.payload) as { error: { code: string } };

      expect(response.statusCode).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when discogsId is not an integer', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/labels/invalid' });
      expect(response.statusCode).toBe(400);
    });
  });
});
