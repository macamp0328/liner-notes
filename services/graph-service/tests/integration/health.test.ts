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

describe('GET /api/v1/health', () => {
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
    await app.close();
  });

  it('returns 200 with ok status when Neo4j is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ status: 'ok', neo4j: 'connected' });
  });

  it('returns 503 with error status when Neo4j is unreachable', async () => {
    mockVerifyConnectivity.mockRejectedValueOnce(new Error('connection refused'));
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.payload)).toEqual({ status: 'error', neo4j: 'disconnected' });
  });

  it('swagger UI is accessible at /api/docs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/docs' });
    expect(response.statusCode).toBe(200);
  });
});
