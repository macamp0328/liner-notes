import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichArtistGenres } from '../../../src/enrichment/artist-genres.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockAggregateArtistGenres = vi.hoisted(() => vi.fn());
const mockAggregateArtistStyles = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/artist-genres-repository.js', () => ({
  aggregateArtistGenres: mockAggregateArtistGenres,
  aggregateArtistStyles: mockAggregateArtistStyles,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichArtistGenres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAggregateArtistGenres.mockResolvedValue(0);
    mockAggregateArtistStyles.mockResolvedValue(0);
  });

  it('calls both aggregation functions', async () => {
    mockAggregateArtistGenres.mockResolvedValue(5);
    mockAggregateArtistStyles.mockResolvedValue(4);

    await enrichArtistGenres(fakeDriver);

    expect(mockAggregateArtistGenres).toHaveBeenCalledWith(fakeDriver);
    expect(mockAggregateArtistStyles).toHaveBeenCalledWith(fakeDriver);
  });

  it('returns enriched = max(genresUpdated, stylesUpdated)', async () => {
    mockAggregateArtistGenres.mockResolvedValue(7);
    mockAggregateArtistStyles.mockResolvedValue(3);

    const summary = await enrichArtistGenres(fakeDriver);

    expect(summary.enriched).toBe(7);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns enriched=0 when no artists have releases', async () => {
    mockAggregateArtistGenres.mockResolvedValue(0);
    mockAggregateArtistStyles.mockResolvedValue(0);

    const summary = await enrichArtistGenres(fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('counts failure when aggregation throws', async () => {
    mockAggregateArtistGenres.mockRejectedValue(new Error('Neo4j connection lost'));

    const summary = await enrichArtistGenres(fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
  });
});
