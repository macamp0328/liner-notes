import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Replace the destructive repository call + driver accessor so the route is
// tested in isolation (no Neo4j). Other repository exports stay real so the
// rest of adminRoutes still imports cleanly.
const mockWipeGraph = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/ingestion-repository.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/db/ingestion-repository.js')>()),
  wipeGraph: mockWipeGraph,
}));
vi.mock('../../../src/db/client.js', () => ({ getDriver: vi.fn().mockReturnValue({}) }));

import { adminRoutes } from '../../../src/api/admin.js';
import { registerSharedSchemas } from '../../../src/api/schemas.js';

const TOKEN = 'secret-token';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // adminRoutes' response schemas $ref the shared ErrorResponse schema; register it
  // before the routes so the reference resolves (buildServer does this in production).
  registerSharedSchemas(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  return app;
}

describe('POST /api/v1/admin/reset', () => {
  const original = process.env['ADMIN_TOKEN'];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['ADMIN_TOKEN'] = TOKEN;
    mockWipeGraph.mockResolvedValue(4217);
  });

  afterEach(() => {
    if (original === undefined) delete process.env['ADMIN_TOKEN'];
    else process.env['ADMIN_TOKEN'] = original;
  });

  it('wipes and returns the deleted count when confirm=wipe-all', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reset?confirm=wipe-all',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ data: { deleted: 4217 } });
      expect(mockWipeGraph).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('refuses (400) and does not wipe without the confirm param', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reset',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('CONFIRMATION_REQUIRED');
      expect(mockWipeGraph).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refuses (400) on a wrong confirm value', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reset?confirm=yes',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      expect(mockWipeGraph).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects (401) without a valid admin token', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reset?confirm=wipe-all',
      });
      expect(res.statusCode).toBe(401);
      expect(mockWipeGraph).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
