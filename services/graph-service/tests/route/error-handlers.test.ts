import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyError, FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { clientErrorCode } from '../../src/api/error-handlers.js';
import { snapshotEnv } from '../helpers/env.js';

// vi.hoisted ensures these are available when vi.mock factories execute
const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockListReleases = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/job-repository.js', () => ({
  findResumableReloadJob: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true), // graph populated → no auto-ingest
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

// listReleases is the seam for the 500-leak test: make it reject with a message
// that mimics a leaked driver error. The other exports must exist because
// collection.ts imports them at module load.
vi.mock('../../src/db/repositories/collection-repository.js', () => ({
  listReleases: mockListReleases,
  getReleaseById: vi.fn().mockResolvedValue(null),
  getArtistById: vi.fn().mockResolvedValue(null),
  getLabelById: vi.fn().mockResolvedValue(null),
}));

interface ErrorBody {
  error: { code: string; message: string };
}

describe('global error + not-found handlers', () => {
  // Optional + guarded close: if buildServer/ready throws, app stays undefined and the
  // cleanup hook is a no-op instead of throwing and masking the original failure.
  let app: FastifyInstance | undefined;
  const env = snapshotEnv(['ADMIN_TOKEN']);

  beforeEach(() => {
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    delete process.env['ADMIN_TOKEN'];
    mockVerifyConnectivity.mockResolvedValue(undefined);
    mockListReleases.mockResolvedValue({ items: [], total: 0 });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    env.restore();
  });

  it('returns a generic 500 envelope without leaking the underlying error message', async () => {
    mockListReleases.mockRejectedValueOnce(new Error('neo4j+s://secret-host:7687 pool exhausted'));
    app = await buildServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/v1/releases' });
    const body = JSON.parse(response.payload) as ErrorBody;

    expect(response.statusCode).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' },
    });
    // The leak guard: the raw driver detail must never reach the response.
    expect(response.payload).not.toContain('secret-host');
  });

  it('returns the error envelope for an unknown route', async () => {
    app = await buildServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    const body = JSON.parse(response.payload) as ErrorBody;

    expect(response.statusCode).toBe(404);
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('rate-limits unknown routes via the not-found preHandler', async () => {
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const get = (): Promise<{ statusCode: number; payload: string }> =>
      app!.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect((await get()).statusCode).toBe(404);
    expect((await get()).statusCode).toBe(404);
    const third = await get();
    const body = JSON.parse(third.payload) as ErrorBody;

    expect(third.statusCode).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('returns the error envelope for a schema validation failure', async () => {
    app = await buildServer();
    await app.ready();

    // discogsId is typed `integer`; a non-numeric param fails ajv coercion → 400.
    const response = await app.inject({ method: 'GET', url: '/api/v1/releases/abc' });
    const body = JSON.parse(response.payload) as ErrorBody;

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('returns the error envelope for a rate-limit 429 and preserves the retry-after header', async () => {
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const url = '/api/v1/health';
    await app.inject({ method: 'GET', url });
    await app.inject({ method: 'GET', url });
    const third = await app.inject({ method: 'GET', url });
    const body = JSON.parse(third.payload) as ErrorBody;

    expect(third.statusCode).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeDefined();
  });

  describe('clientErrorCode', () => {
    it('maps validation errors to VALIDATION_ERROR', () => {
      const err = { validation: [{ message: 'bad' }] } as unknown as FastifyError;
      expect(clientErrorCode(err, 400)).toBe('VALIDATION_ERROR');
    });

    it('maps 429 to RATE_LIMITED', () => {
      expect(clientErrorCode({} as FastifyError, 429)).toBe('RATE_LIMITED');
    });

    it('falls back to CLIENT_ERROR for any other 4xx', () => {
      expect(clientErrorCode({} as FastifyError, 422)).toBe('CLIENT_ERROR');
    });
  });
});
