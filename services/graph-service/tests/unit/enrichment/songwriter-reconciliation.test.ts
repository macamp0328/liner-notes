import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichSongwriterReconciliation } from '../../../src/enrichment/songwriter-reconciliation.js';

const mockReconcileWroteEdges = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/songwriter-reconciliation-repository.js', () => ({
  reconcileWroteEdges: mockReconcileWroteEdges,
}));

const fakeDriver = {} as Driver;

describe('enrichSongwriterReconciliation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the reconciled WROTE-edge count on success', async () => {
    mockReconcileWroteEdges.mockResolvedValue(23);
    const summary = await enrichSongwriterReconciliation(fakeDriver);
    expect(summary.linksReconciled).toBe(23);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockReconcileWroteEdges).toHaveBeenCalledWith(fakeDriver);
  });

  it('propagates the error so the reload stage is marked failed and retried on resume', async () => {
    mockReconcileWroteEdges.mockRejectedValue(new Error('neo4j down'));
    await expect(enrichSongwriterReconciliation(fakeDriver)).rejects.toThrow('neo4j down');
  });
});
