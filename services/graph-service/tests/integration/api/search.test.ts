import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { seedGraph, clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';

describe('search routes', () => {
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

  describe('GET /api/v1/search', () => {
    it('returns ranked results for a real query', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=Hancock' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { type: string; score: number }[];
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((r) => typeof r.score === 'number')).toBe(true);
    });

    it('returns an empty array for a query with no matches', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=zzzzzunmatchedzzzzz' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });

    it('returns 400 when q is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({
        error: { code: 'MISSING_QUERY', message: 'q is required and must not be empty' },
      });
    });

    it('returns 400 when q is whitespace-only', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=%20%20' });
      expect(res.statusCode).toBe(400);
    });

    // #289: hostile Lucene syntax must not reach the parser as a 500 (which would trip the
    // CloudWatch level>=50 alarm). Real Neo4j is the only layer that proves this end-to-end.
    it.each(['(', '"', 'AND', '*a*~', 'foo )', 'a~b^', '<>'])(
      'returns 200 (never 500) for hostile q=%s',
      async (q) => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/search?q=${encodeURIComponent(q)}`,
        });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
      },
    );

    it('returns 400 when q exceeds 500 chars', async () => {
      const long = 'a'.repeat(501);
      const res = await app.inject({ method: 'GET', url: `/api/v1/search?q=${long}` });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({
        error: { code: 'QUERY_TOO_LONG', message: 'q must be 500 characters or fewer' },
      });
    });
  });

  describe('GET /api/v1/search/lyrics', () => {
    it('returns an array (likely empty without lyrics enrichment)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search/lyrics?q=love' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
    });

    // #289: same hostile-input guard for the lyrics index.
    it.each(['(', '"', 'AND', '*a*~', 'foo )', 'a~b^', '<>'])(
      'returns 200 (never 500) for hostile q=%s',
      async (q) => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/search/lyrics?q=${encodeURIComponent(q)}`,
        });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
      },
    );

    it('returns 400 when q is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search/lyrics' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when q exceeds 500 chars', async () => {
      const long = 'a'.repeat(501);
      const res = await app.inject({ method: 'GET', url: `/api/v1/search/lyrics?q=${long}` });
      expect(res.statusCode).toBe(400);
    });
  });
});
