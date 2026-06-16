import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichArtistInfluences } from '../../../src/enrichment/artist-influences.js';

const mockLinkInfluencedBy = vi.hoisted(() => vi.fn());
const mockCountInfluenceCandidates = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-influences-repository.js', () => ({
  linkInfluencedBy: mockLinkInfluencedBy,
  countInfluenceCandidates: mockCountInfluenceCandidates,
}));

const fakeDriver = {} as Driver;

describe('enrichArtistInfluences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the INFLUENCED_BY edge count and the candidate denominator on success', async () => {
    mockLinkInfluencedBy.mockResolvedValue(23);
    mockCountInfluenceCandidates.mockResolvedValue(155);
    const summary = await enrichArtistInfluences(fakeDriver);
    expect(summary.influencedByLinks).toBe(23);
    expect(summary.influencedByCandidates).toBe(155);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockLinkInfluencedBy).toHaveBeenCalledWith(fakeDriver);
    expect(mockCountInfluenceCandidates).toHaveBeenCalledWith(fakeDriver);
  });

  it('propagates the error (throws) so the reload stage is marked failed and retried on resume', async () => {
    // All-or-nothing MERGE: a throw lets the orchestrator record the stage `failed` (kept out of
    // ranStages/doneStages) rather than laundering it into a `complete` outcome that resume skips.
    mockLinkInfluencedBy.mockRejectedValue(new Error('neo4j down'));
    await expect(enrichArtistInfluences(fakeDriver)).rejects.toThrow('neo4j down');
  });
});
