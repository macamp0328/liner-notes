import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { seedGraph, clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';

// Maiden Voyage (Herbie Hancock, Blue Note, 1966) — present in the seed fixtures.
const SEED_RELEASE_ID = 7000001;
const SEED_ARTIST_ID = 400001;
const SEED_LABEL_ID = 200001;

describe('collection routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
    await clearGraph(getDriver());
    await seedGraph(getDriver());
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  describe('GET /api/v1/releases', () => {
    it('returns paginated releases with totalPages and capped limit', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/releases?page=1&limit=5' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        data: { discogsId: number; title: string }[];
        pagination: { page: number; limit: number; total: number; totalPages: number };
      };
      expect(body.data.length).toBeLessThanOrEqual(5);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(5);
      expect(body.pagination.total).toBeGreaterThanOrEqual(10);
      expect(body.pagination.totalPages).toBeGreaterThanOrEqual(2);
    });

    it('rejects limit > 100 via schema', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/releases?limit=500' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/releases/:discogsId', () => {
    it('returns the hydrated release on a known discogsId', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/releases/${SEED_RELEASE_ID}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        data: {
          discogsId: number;
          title: string;
          tracks: { position: string; title: string }[];
          credits: { name: string }[];
        };
      };
      expect(body.data.discogsId).toBe(SEED_RELEASE_ID);
      expect(body.data.title).toBe('Maiden Voyage');
      expect(body.data.tracks.map((t) => t.position)).toContain('A1');
      expect(body.data.credits.some((c) => c.name === 'Ron Carter')).toBe(true);
    });

    it('returns 404 when the release is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/releases/1' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({
        error: { code: 'NOT_FOUND', message: 'Release not found' },
      });
    });
  });

  describe('GET /api/v1/artists/:discogsId', () => {
    it('returns the artist with releases', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/artists/${SEED_ARTIST_ID}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        data: { discogsId: number; name: string; releases: { discogsId: number }[] };
      };
      expect(body.data.discogsId).toBe(SEED_ARTIST_ID);
      expect(body.data.name).toBe('Herbie Hancock');
      expect(body.data.releases.length).toBeGreaterThan(0);
    });

    it('returns 404 when the artist is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/artists/1' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/labels/:discogsId', () => {
    it('returns the label with releases', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/labels/${SEED_LABEL_ID}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        data: { discogsId: number; name: string; releases: { discogsId: number }[] };
      };
      expect(body.data.discogsId).toBe(SEED_LABEL_ID);
      expect(body.data.name).toBe('Blue Note Records');
      expect(body.data.releases.length).toBeGreaterThan(0);
    });

    it('returns 404 when the label is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/labels/1' });
      expect(res.statusCode).toBe(404);
    });
  });
});
