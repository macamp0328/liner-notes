import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { snapshotEnv } from '../helpers/env.js';

// vi.hoisted ensures these are available when vi.mock factories execute
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

describe('global rate limiting', () => {
  // Optional + guarded close: if buildServer/ready throws, app stays undefined and the
  // cleanup hook is a no-op instead of throwing and masking the original failure.
  let app: FastifyInstance | undefined;
  const env = snapshotEnv(['ADMIN_TOKEN']);

  beforeEach(() => {
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    // No ADMIN_TOKEN by default — the allowList must not exempt unauthenticated traffic.
    delete process.env['ADMIN_TOKEN'];
    mockVerifyConnectivity.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    env.restore();
  });

  const url = '/api/v1/health';

  it('returns 429 once a client exceeds the configured per-window cap', async () => {
    // Explicit low cap overrides the test-env unbounded default (resolveRateLimitMax).
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const first = await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });
    const third = await app.inject({ method: 'GET', url });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it('gives distinct cf-connecting-ip clients independent buckets when trustCfIp is on', async () => {
    app = await buildServer({ rateLimitMax: 2, trustCfIp: true });
    await app.ready();

    const get = (ip: string): Promise<{ statusCode: number }> =>
      app!.inject({ method: 'GET', url, headers: { 'cf-connecting-ip': ip } });

    // Client A exhausts its own bucket...
    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('1.1.1.1')).statusCode).toBe(429);
    // ...while client B is untouched.
    expect((await get('2.2.2.2')).statusCode).toBe(200);
  });

  it('shares one bucket across forwarded IPs when trustCfIp is off (the bug guard)', async () => {
    // Off by default: cf-connecting-ip is ignored, every inject keys on 127.0.0.1.
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const get = (ip: string): Promise<{ statusCode: number }> =>
      app!.inject({ method: 'GET', url, headers: { 'cf-connecting-ip': ip } });

    expect((await get('1.1.1.1')).statusCode).toBe(200);
    expect((await get('2.2.2.2')).statusCode).toBe(200);
    expect((await get('3.3.3.3')).statusCode).toBe(429);
  });

  it('exempts authenticated admin calls from the cap', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token';
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const headers = { authorization: 'Bearer secret-token' };
    const first = await app.inject({ method: 'GET', url, headers });
    const second = await app.inject({ method: 'GET', url, headers });
    const third = await app.inject({ method: 'GET', url, headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
  });

  it('still limits requests carrying a wrong bearer token', async () => {
    process.env['ADMIN_TOKEN'] = 'secret-token';
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const headers = { authorization: 'Bearer wrong-token' };
    const first = await app.inject({ method: 'GET', url, headers });
    const second = await app.inject({ method: 'GET', url, headers });
    const third = await app.inject({ method: 'GET', url, headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });
});
