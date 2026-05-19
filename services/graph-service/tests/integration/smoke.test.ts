import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from './setup.js';
import { seedGraph, clearGraph } from '../fixtures/loader.js';
import { getDriver } from '../../src/db/client.js';

describe('integration harness smoke test', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
    await clearGraph(getDriver());
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  it('seedGraph loads fixtures and clearGraph wipes them', async () => {
    await seedGraph(getDriver());

    const seeded = await app.inject({ method: 'GET', url: '/api/v1/releases?limit=50' });
    expect(seeded.statusCode).toBe(200);
    const seededBody = JSON.parse(seeded.payload) as { pagination: { total: number } };
    expect(seededBody.pagination.total).toBeGreaterThanOrEqual(10);

    await clearGraph(getDriver());

    const cleared = await app.inject({ method: 'GET', url: '/api/v1/releases' });
    expect(cleared.statusCode).toBe(200);
    const clearedBody = JSON.parse(cleared.payload) as { pagination: { total: number } };
    expect(clearedBody.pagination.total).toBe(0);
  });
});
