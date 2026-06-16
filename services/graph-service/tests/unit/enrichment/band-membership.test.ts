import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichBandMemberships } from '../../../src/enrichment/band-membership.js';

const mockLinkBandMemberships = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/band-membership-repository.js', () => ({
  linkBandMemberships: mockLinkBandMemberships,
}));

const fakeDriver = {} as Driver;

describe('enrichBandMemberships', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the MEMBER_OF edge count on success', async () => {
    mockLinkBandMemberships.mockResolvedValue(42);
    const summary = await enrichBandMemberships(fakeDriver);
    expect(summary.membershipLinks).toBe(42);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockLinkBandMemberships).toHaveBeenCalledWith(fakeDriver);
  });

  it('propagates the error (throws) so the reload stage is marked failed and retried on resume', async () => {
    // All-or-nothing MERGE: a throw lets the orchestrator record the stage `failed` (kept out of
    // ranStages/doneStages) rather than laundering it into a `complete` outcome that resume skips.
    mockLinkBandMemberships.mockRejectedValue(new Error('neo4j down'));
    await expect(enrichBandMemberships(fakeDriver)).rejects.toThrow('neo4j down');
  });
});
