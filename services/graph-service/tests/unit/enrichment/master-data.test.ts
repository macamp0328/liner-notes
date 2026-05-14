import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichMasterData } from '../../../src/enrichment/master-data.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedMasters = vi.hoisted(() => vi.fn());
const mockMergeMasterData = vi.hoisted(() => vi.fn());
const mockSetMasterFetchedAndOriginalYear = vi.hoisted(() => vi.fn());
const mockSetMasterFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/master-data-repository.js', () => ({
  getUnenrichedMasters: mockGetUnenrichedMasters,
  mergeMasterData: mockMergeMasterData,
  setMasterFetchedAndOriginalYear: mockSetMasterFetchedAndOriginalYear,
  setMasterFetched: mockSetMasterFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeVersionsPage(
  versions: Array<{ id: number; country?: string; major_formats: string[] }>,
  page = 1,
  pages = 1,
) {
  return {
    versions: versions.map((v) => ({ title: 'Test', released: '1978', ...v })),
    pagination: { page, pages, per_page: 100, items: versions.length },
  };
}

function makeClient(overrides?: {
  getMaster?: ReturnType<typeof vi.fn>;
  getMasterVersions?: ReturnType<typeof vi.fn>;
}) {
  return {
    getMaster:
      overrides?.getMaster ?? vi.fn().mockResolvedValue({ id: 100, title: 'Hejira', year: 1976 }),
    getMasterVersions:
      overrides?.getMasterVersions ??
      vi
        .fn()
        .mockResolvedValue(makeVersionsPage([{ id: 1, country: 'US', major_formats: ['Vinyl'] }])),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

const sampleMaster = { masterDiscogsId: 100, releaseIds: [13570466] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichMasterData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedMasters.mockResolvedValue([]);
    mockMergeMasterData.mockResolvedValue(undefined);
    mockSetMasterFetchedAndOriginalYear.mockResolvedValue(undefined);
    mockSetMasterFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when nothing to enrich', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([]);
    const client = makeClient();

    const summary = await enrichMasterData(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.getMaster).not.toHaveBeenCalled();
  });

  it('fetches master + paginates versions and creates enriched=1', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster]);
    const client = makeClient();

    const summary = await enrichMasterData(client, fakeDriver);

    expect(client.getMaster).toHaveBeenCalledWith(100);
    expect(client.getMasterVersions).toHaveBeenCalledWith(100, 1, 100);
    expect(mockMergeMasterData).toHaveBeenCalledOnce();
    expect(mockSetMasterFetchedAndOriginalYear).toHaveBeenCalledWith(fakeDriver, [13570466], 1976);
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('skips master with year=0 and marks releases fetched without setting originalYear', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster]);
    const client = makeClient({
      getMaster: vi.fn().mockResolvedValue({ id: 100, title: 'Unknown', year: 0 }),
    });

    const summary = await enrichMasterData(client, fakeDriver);

    expect(mockMergeMasterData).not.toHaveBeenCalled();
    expect(mockSetMasterFetchedAndOriginalYear).not.toHaveBeenCalled();
    expect(mockSetMasterFetched).toHaveBeenCalledWith(fakeDriver, [13570466]);
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('aggregates multiple versions from same country into one CountryWithFormats entry with merged formats', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster]);
    const client = makeClient({
      getMasterVersions: vi.fn().mockResolvedValue(
        makeVersionsPage([
          { id: 1, country: 'US', major_formats: ['Vinyl'] },
          { id: 2, country: 'US', major_formats: ['CD'] },
          { id: 3, country: 'GB', major_formats: ['Vinyl'] },
        ]),
      ),
    });

    await enrichMasterData(client, fakeDriver);

    const mergeCall = mockMergeMasterData.mock.calls[0];
    // 5th arg (index 4) is countriesWithFormats: (driver, masterDiscogsId, title, year, countriesWithFormats)
    const countriesWithFormats = mergeCall?.[4] as Array<{
      country: string;
      formats: string[];
    }>;

    const us = countriesWithFormats.find((c) => c.country === 'US');
    expect(us).toBeDefined();
    expect(us?.formats.sort()).toEqual(['CD', 'Vinyl']);

    const gb = countriesWithFormats.find((c) => c.country === 'GB');
    expect(gb).toBeDefined();
    expect(gb?.formats).toEqual(['Vinyl']);
  });

  it('handles multiple pages of versions (pagination loop)', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster]);
    const getMasterVersions = vi
      .fn()
      .mockResolvedValueOnce(
        makeVersionsPage([{ id: 1, country: 'US', major_formats: ['Vinyl'] }], 1, 2),
      )
      .mockResolvedValueOnce(
        makeVersionsPage([{ id: 2, country: 'DE', major_formats: ['Vinyl'] }], 2, 2),
      );

    const client = makeClient({ getMasterVersions });

    await enrichMasterData(client, fakeDriver);

    expect(getMasterVersions).toHaveBeenCalledTimes(2);
    expect(getMasterVersions).toHaveBeenCalledWith(100, 1, 100);
    expect(getMasterVersions).toHaveBeenCalledWith(100, 2, 100);

    // 5th arg (index 4) is countriesWithFormats
    const countriesWithFormats = mockMergeMasterData.mock.calls[0]?.[4] as Array<{
      country: string;
    }>;
    const countries = countriesWithFormats.map((c) => c.country).sort();
    expect(countries).toEqual(['DE', 'US']);
  });

  it('handles per-master failure in isolation — failed=1, continues to next master', async () => {
    const master2 = { masterDiscogsId: 200, releaseIds: [9999991] };
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster, master2]);

    const getMaster = vi
      .fn()
      .mockRejectedValueOnce(new Error('Discogs API error 503'))
      .mockResolvedValueOnce({ id: 200, title: 'Other Album', year: 1980 });

    const client = makeClient({ getMaster });

    const summary = await enrichMasterData(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetMasterFetchedAndOriginalYear).toHaveBeenCalledOnce();
    expect(mockSetMasterFetchedAndOriginalYear).toHaveBeenCalledWith(fakeDriver, [9999991], 1980);
  });

  it('returns failed=1 early when DB fetch of unenriched masters fails', async () => {
    mockGetUnenrichedMasters.mockRejectedValue(new Error('DB connection lost'));
    const client = makeClient();

    const summary = await enrichMasterData(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(client.getMaster).not.toHaveBeenCalled();
  });

  it('calls setMasterFetched (not setMasterFetchedAndOriginalYear) when year is negative', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster]);
    const client = makeClient({
      getMaster: vi.fn().mockResolvedValue({ id: 100, title: 'Unknown', year: -1 }),
    });

    await enrichMasterData(client, fakeDriver);

    expect(mockSetMasterFetchedAndOriginalYear).not.toHaveBeenCalled();
    expect(mockSetMasterFetched).toHaveBeenCalledWith(fakeDriver, [13570466]);
  });

  it('skips versions with empty country and only stores non-empty countries', async () => {
    mockGetUnenrichedMasters.mockResolvedValue([sampleMaster]);
    const client = makeClient({
      getMasterVersions: vi.fn().mockResolvedValue(
        makeVersionsPage([
          { id: 1, country: 'US', major_formats: ['Vinyl'] },
          { id: 2, major_formats: ['CD'] },
          { id: 3, country: '  ', major_formats: ['Vinyl'] },
        ]),
      ),
    });

    await enrichMasterData(client, fakeDriver);

    const countriesWithFormats = mockMergeMasterData.mock.calls[0]?.[4] as Array<{
      country: string;
    }>;
    expect(countriesWithFormats).toHaveLength(1);
    expect(countriesWithFormats[0]?.country).toBe('US');
  });
});
