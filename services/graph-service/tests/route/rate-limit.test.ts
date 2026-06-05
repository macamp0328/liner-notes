import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

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

  beforeEach(() => {
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    mockVerifyConnectivity.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 429 once a client exceeds the configured per-window cap', async () => {
    // Explicit low cap overrides the test-env unbounded default (resolveRateLimitMax).
    app = await buildServer({ rateLimitMax: 2 });
    await app.ready();

    const url = '/api/v1/health';
    const first = await app.inject({ method: 'GET', url });
    const second = await app.inject({ method: 'GET', url });
    const third = await app.inject({ method: 'GET', url });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });
});
