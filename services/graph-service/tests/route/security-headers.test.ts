import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { snapshotEnv } from '../helpers/env.js';

// vi.hoisted ensures the mock is available when the vi.mock factory executes.
const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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

describe('security headers (@fastify/helmet)', () => {
  const env = snapshotEnv(['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD', 'NODE_ENV', 'ADMIN_TOKEN']);
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    mockVerifyConnectivity.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    env.restore();
  });

  it('sets baseline security headers on every response', async () => {
    app = await buildServer();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // CSP is production-only — its defaults would block Swagger UI's inline assets.
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('enables Content-Security-Policy in production (Swagger UI is not mounted there)', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ADMIN_TOKEN'] = 'test-admin-token';
    app = await buildServer({ logger: false });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
