import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph, seedGraph, seedEntityResolution } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { enrichPersonReconciliation } from '../../../src/enrichment/person-reconciliation.js';

/** SAME_PERSON_AS edges between the seeded Musician + Artist that share discogsId 900400. */
async function reconcileMeEdgeCount(): Promise<number> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (:Musician {discogsId: 900400})-[r:SAME_PERSON_AS]->(:Artist {discogsId: 900400})
       RETURN count(r) AS c`,
    );
    return (res.records[0]?.get('c') as { toNumber(): number }).toNumber();
  } finally {
    await session.close();
  }
}

describe('person-reconciliation pass (#330)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
    await clearGraph(getDriver());
    await seedGraph(getDriver());
    await seedEntityResolution(getDriver());
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  it('backfills SAME_PERSON_AS for a Musician + Artist sharing a discogsId', async () => {
    // "Reconcile Me" (900400) was seeded deliberately UNLINKED.
    expect(await reconcileMeEdgeCount()).toBe(0);

    const summary = await enrichPersonReconciliation(getDriver());
    expect(summary.failed).toBe(0);
    expect(summary.linksReconciled).toBeGreaterThan(0);

    expect(await reconcileMeEdgeCount()).toBe(1);
  });

  it('is idempotent — a second run leaves exactly one edge', async () => {
    const summary = await enrichPersonReconciliation(getDriver());
    expect(summary.failed).toBe(0);
    expect(await reconcileMeEdgeCount()).toBe(1);
  });
});
