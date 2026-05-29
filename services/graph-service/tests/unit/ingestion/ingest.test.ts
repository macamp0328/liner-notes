import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Hoisted mocks — the repository write + every enrichment stage are replaced
// so runIngestion's orchestration can be tested without Neo4j or Discogs.
// ---------------------------------------------------------------------------
const mockMergeReleaseGraph = vi.hoisted(() => vi.fn());
const mockEnrichLyrics = vi.hoisted(() => vi.fn());
const mockEnrichMasterData = vi.hoisted(() => vi.fn());
const mockEnrichArtistGenres = vi.hoisted(() => vi.fn());
const mockEnrichTrackVersions = vi.hoisted(() => vi.fn());
const mockEnrichArtistProfiles = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  mergeReleaseGraph: mockMergeReleaseGraph,
}));
vi.mock('../../../src/enrichment/lyrics.js', () => ({ enrichLyrics: mockEnrichLyrics }));
vi.mock('../../../src/enrichment/master-data.js', () => ({
  enrichMasterData: mockEnrichMasterData,
}));
vi.mock('../../../src/enrichment/artist-genres.js', () => ({
  enrichArtistGenres: mockEnrichArtistGenres,
}));
vi.mock('../../../src/enrichment/track-versions.js', () => ({
  enrichTrackVersions: mockEnrichTrackVersions,
}));
vi.mock('../../../src/enrichment/artist-profiles.js', () => ({
  enrichArtistProfiles: mockEnrichArtistProfiles,
}));

import { runIngestion } from '../../../src/ingestion/ingest.js';
import type { DiscogsClient } from '../../../src/ingestion/discogs-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

const LYRICS_OK = { enriched: 5, skipped: 1, failed: 0, durationMs: 10 };
const MASTER_OK = { enriched: 3, skipped: 0, failed: 0, durationMs: 10 };
const GENRES_OK = { genresEnriched: 2, stylesEnriched: 3, skipped: 0, failed: 0, durationMs: 5 };
const VERSIONS_OK = { enriched: 1, skipped: 0, failed: 0, durationMs: 5 };
const PROFILES_OK = { enriched: 4, skipped: 0, failed: 0, durationMs: 5 };

function makeClient(overrides: Partial<Record<keyof DiscogsClient, unknown>> = {}): DiscogsClient {
  return {
    getCollectionReleases: vi.fn().mockResolvedValue({ pagination: { pages: 1 }, releases: [] }),
    getRelease: vi.fn(),
    ...overrides,
  } as unknown as DiscogsClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('runIngestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnrichLyrics.mockResolvedValue(LYRICS_OK);
    mockEnrichMasterData.mockResolvedValue(MASTER_OK);
    mockEnrichArtistGenres.mockResolvedValue(GENRES_OK);
    mockEnrichTrackVersions.mockResolvedValue(VERSIONS_OK);
    mockEnrichArtistProfiles.mockResolvedValue(PROFILES_OK);
  });

  it('runs every enrichment stage and aggregates their summaries', async () => {
    const client = makeClient();

    const summary = await runIngestion(client, fakeDriver, { username: 'tester', logger: log });

    expect(mockEnrichLyrics).toHaveBeenCalledOnce();
    expect(mockEnrichMasterData).toHaveBeenCalledOnce();
    expect(mockEnrichArtistGenres).toHaveBeenCalledOnce();
    expect(mockEnrichTrackVersions).toHaveBeenCalledOnce();
    expect(mockEnrichArtistProfiles).toHaveBeenCalledOnce();

    expect(summary.lyricsEnrichment).toEqual(LYRICS_OK);
    expect(summary.masterDataEnrichment).toEqual(MASTER_OK);
    expect(summary.artistProfilesEnrichment).toEqual(PROFILES_OK);
    expect(summary.errors).toHaveLength(0);
  });

  it('isolates a thrown stage: later stages still run and the run resolves (#151)', async () => {
    // master-data (stage 4) throws — previously this aborted genres, versions,
    // and profiles for the whole run, leaving them permanently null.
    mockEnrichMasterData.mockRejectedValue(new Error('Aura write timeout'));
    const client = makeClient();

    const summary = await runIngestion(client, fakeDriver, { username: 'tester', logger: log });

    // The stages after the throw still ran.
    expect(mockEnrichArtistGenres).toHaveBeenCalledOnce();
    expect(mockEnrichTrackVersions).toHaveBeenCalledOnce();
    expect(mockEnrichArtistProfiles).toHaveBeenCalledOnce();

    // The failed stage reports its fallback (zeroed) summary...
    expect(summary.masterDataEnrichment).toEqual({
      enriched: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    });
    // ...while the surviving stages report real progress.
    expect(summary.artistProfilesEnrichment).toEqual(PROFILES_OK);

    // The error is recorded for the run summary / CloudWatch, not swallowed.
    expect(summary.errors.some((e) => e.includes('master-data'))).toBe(true);
  });

  it('records the first thrown stage without preventing the others (#151)', async () => {
    // Even the very first enrichment stage throwing must not abort the rest.
    mockEnrichLyrics.mockRejectedValue(new Error('Neo4j unavailable'));
    const client = makeClient();

    const summary = await runIngestion(client, fakeDriver, { username: 'tester', logger: log });

    expect(mockEnrichMasterData).toHaveBeenCalledOnce();
    expect(mockEnrichArtistProfiles).toHaveBeenCalledOnce();
    expect(summary.lyricsEnrichment).toEqual({
      enriched: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    });
    expect(summary.errors.some((e) => e.includes('lyrics'))).toBe(true);
  });

  it('processes releases and counts per-release failures without aborting', async () => {
    const client = makeClient({
      getCollectionReleases: vi
        .fn()
        .mockResolvedValue({ pagination: { pages: 1 }, releases: [{ id: 1 }, { id: 2 }] }),
      getRelease: vi
        .fn()
        .mockResolvedValueOnce({ id: 1 })
        .mockRejectedValueOnce(new Error('Discogs 500')),
    });

    const summary = await runIngestion(client, fakeDriver, { username: 'tester', logger: log });

    expect(summary.releasesProcessed).toBe(1);
    expect(summary.releasesFailed).toBe(1);
    expect(summary.errors.some((e) => e.includes('Release 2'))).toBe(true);
    expect(mockMergeReleaseGraph).toHaveBeenCalledOnce();
    // Enrichment still runs after per-release failures.
    expect(mockEnrichLyrics).toHaveBeenCalledOnce();
  });
});
