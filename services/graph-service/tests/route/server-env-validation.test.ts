import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';

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

// onReady calls hasReleases() after applySchema; pretend the graph is populated
// so the default autoIngest path short-circuits without touching Discogs.
vi.mock('../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

describe('buildServer onReady — Neo4j env validation', () => {
  const KEYS = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    mockVerifyConnectivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('starts when NEO4J_PASSWORD is an explicitly-empty string (NEO4J_AUTH=none)', async () => {
    process.env['NEO4J_PASSWORD'] = '';
    const app = await buildServer();
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('throws when a required var is unset', async () => {
    delete process.env['NEO4J_PASSWORD'];
    const app = await buildServer();
    await expect(app.ready()).rejects.toThrow(/must be set/);
    await app.close().catch(() => undefined);
  });
});
