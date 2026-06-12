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

  it('isolates a failure (failed=1, never throws)', async () => {
    mockReconcileSamePersonLinks.mockRejectedValue(new Error('neo4j down'));
    const summary = await enrichPersonReconciliation(fakeDriver);
    expect(summary.failed).toBe(1);
    expect(summary.linksReconciled).toBe(0);
  });
});
