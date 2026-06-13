import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichPersonReconciliation } from '../../../src/enrichment/person-reconciliation.js';

const mockReconcileSamePersonLinks = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/person-reconciliation-repository.js', () => ({
  reconcileSamePersonLinks: mockReconcileSamePersonLinks,
}));

const fakeDriver = {} as Driver;

describe('enrichPersonReconciliation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the reconciled link count on success', async () => {
    mockReconcileSamePersonLinks.mockResolvedValue(17);
    const summary = await enrichPersonReconciliation(fakeDriver);
    expect(summary.linksReconciled).toBe(17);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockReconcileSamePersonLinks).toHaveBeenCalledWith(fakeDriver);
  });

  it('propagates the error (throws) so the reload stage is marked failed and retried on resume', async () => {
    // All-or-nothing MERGE: a throw lets the orchestrator record the stage `failed` (kept out of
    // ranStages/doneStages) rather than laundering it into a `complete` outcome that resume skips.
    mockReconcileSamePersonLinks.mockRejectedValue(new Error('neo4j down'));
    await expect(enrichPersonReconciliation(fakeDriver)).rejects.toThrow('neo4j down');
  });
});
