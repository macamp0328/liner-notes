import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { seedGraph, clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { snapshotEnv, type EnvSnapshot } from '../../helpers/env.js';

const TEST_TOKEN = 'test-admin-token-reset';

async function nodeCount(): Promise<number> {
  const session = getDriver().session();
  try {
    const res = await session.run('MATCH (n) RETURN count(n) AS c');
    return (res.records[0]?.get('c') as { toNumber(): number }).toNumber();
  } finally {
    await session.close();
  }
}

describe('POST /api/v1/admin/reset', () => {
  let app: FastifyInstance;
  let envSnapshot: EnvSnapshot;

  beforeAll(async () => {
    app = await buildTestServer();
    envSnapshot = snapshotEnv(['ADMIN_TOKEN']);
    process.env['ADMIN_TOKEN'] = TEST_TOKEN;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await clearGraph(getDriver());
    await app.close();
  });

  it('refuses without confirm and leaves the graph intact', async () => {
    await clearGraph(getDriver());
    await seedGraph(getDriver());
    const before = await nodeCount();
    expect(before).toBeGreaterThan(0);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('CONFIRMATION_REQUIRED');
    expect(await nodeCount()).toBe(before); // unchanged
  });

  it('wipes the entire graph with confirm=wipe-all', async () => {
    await clearGraph(getDriver());
    await seedGraph(getDriver());
    expect(await nodeCount()).toBeGreaterThan(0);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset?confirm=wipe-all',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as { data: { deleted: number } };
    expect(body.data.deleted).toBeGreaterThan(0);
    expect(await nodeCount()).toBe(0); // graph fully empty
  });
});
