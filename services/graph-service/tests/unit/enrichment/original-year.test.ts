import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichOriginalYear } from '../../../src/enrichment/original-year.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedReleases = vi.hoisted(() => vi.fn());
const mockSetOriginalYear = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/original-year-repository.js', () => ({
  getUnenrichedReleases: mockGetUnenrichedReleases,
  setOriginalYear: mockSetOriginalYear,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeClient(
  getMasterImpl?: (id: number) => Promise<{ id: number; title: string; year: number }>,
) {
  return {
    getMaster: getMasterImpl
      ? vi.fn().mockImplementation(getMasterImpl)
      : vi.fn().mockResolvedValue({ id: 100, title: 'Master Title', year: 1974 }),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

const sampleRelease = { discogsId: 13570466, masterDiscogsId: 100 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichOriginalYear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedReleases.mockResolvedValue([]);
    mockSetOriginalYear.mockResolvedValue(undefined);
  });

  it('returns zero counts when no releases need enrichment', async () => {
    mockGetUnenrichedReleases.mockResolvedValue([]);
    const client = makeClient();

    const summary = await enrichOriginalYear(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.getMaster).not.toHaveBeenCalled();
  });

  it('fetches master and sets originalYear for each unenriched release', async () => {
    mockGetUnenrichedReleases.mockResolvedValue([sampleRelease]);
    const client = makeClient();

    const summary = await enrichOriginalYear(client, fakeDriver);

    expect(client.getMaster).toHaveBeenCalledWith(100);
    expect(mockSetOriginalYear).toHaveBeenCalledWith(fakeDriver, 13570466, 1974);
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('skips releases where master returns year 0', async () => {
    mockGetUnenrichedReleases.mockResolvedValue([sampleRelease]);
    const client = makeClient(async () => ({ id: 100, title: 'Master', year: 0 }));

    const summary = await enrichOriginalYear(client, fakeDriver);

    expect(mockSetOriginalYear).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('counts failures per release when getMaster throws', async () => {
    const release2 = { discogsId: 9999991, masterDiscogsId: 200 };
    mockGetUnenrichedReleases.mockResolvedValue([sampleRelease, release2]);

    const client = {
      getMaster: vi
        .fn()
        .mockRejectedValueOnce(new Error('Discogs API error 503'))
        .mockResolvedValueOnce({ id: 200, title: 'Other Master', year: 1976 }),
    } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;

    const summary = await enrichOriginalYear(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetOriginalYear).toHaveBeenCalledTimes(1);
    expect(mockSetOriginalYear).toHaveBeenCalledWith(fakeDriver, 9999991, 1976);
  });

  it('is idempotent — only processes releases where originalYear IS NULL', async () => {
    // Idempotency is enforced at the DB layer (getUnenrichedReleases uses IS NULL filter).
    // Here we verify enrichOriginalYear doesn't re-process if the repo returns an empty list.
    mockGetUnenrichedReleases.mockResolvedValue([]);
    const client = makeClient();

    const summary1 = await enrichOriginalYear(client, fakeDriver);
    const summary2 = await enrichOriginalYear(client, fakeDriver);

    expect(client.getMaster).not.toHaveBeenCalled();
    expect(summary1.enriched).toBe(0);
    expect(summary2.enriched).toBe(0);
  });

  it('continues processing remaining releases after a failure', async () => {
    const releases = [
      { discogsId: 1, masterDiscogsId: 10 },
      { discogsId: 2, masterDiscogsId: 20 },
      { discogsId: 3, masterDiscogsId: 30 },
    ];
    mockGetUnenrichedReleases.mockResolvedValue(releases);

    const client = {
      getMaster: vi
        .fn()
        .mockResolvedValueOnce({ id: 10, title: 'A', year: 1970 })
        .mockRejectedValueOnce(new Error('Rate limit'))
        .mockResolvedValueOnce({ id: 30, title: 'C', year: 1980 }),
    } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;

    const summary = await enrichOriginalYear(client, fakeDriver);

    expect(summary.enriched).toBe(2);
    expect(summary.failed).toBe(1);
    expect(mockSetOriginalYear).toHaveBeenCalledTimes(2);
  });
});
