import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichTrackVersions } from '../../../src/enrichment/track-versions.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetVersionCandidates = vi.hoisted(() => vi.fn());
const mockMergeVersionRelationships = vi.hoisted(() => vi.fn());
const mockReleasesShareArtist = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/track-versions-repository.js', () => ({
  getVersionCandidates: mockGetVersionCandidates,
  mergeVersionRelationships: mockMergeVersionRelationships,
  releasesShareArtist: mockReleasesShareArtist,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeTracks(
  normalizedTitle: string,
  entries: Array<{ elementId: string; title: string; releaseDiscogsId: number }>,
) {
  return { normalizedTitle, tracks: entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichTrackVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersionCandidates.mockResolvedValue([]);
    mockMergeVersionRelationships.mockResolvedValue(undefined);
    mockReleasesShareArtist.mockResolvedValue(true);
  });

  it('returns zero counts when no candidate groups exist', async () => {
    mockGetVersionCandidates.mockResolvedValue([]);

    const summary = await enrichTrackVersions(fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(mockMergeVersionRelationships).not.toHaveBeenCalled();
  });

  it('creates IS_VERSION_OF relationships for a valid group', async () => {
    const group = makeTracks('just like that', [
      { elementId: 'a', title: 'Just Like That', releaseDiscogsId: 100 },
      { elementId: 'b', title: 'Just Like That (Remix)', releaseDiscogsId: 200 },
      { elementId: 'c', title: 'Just Like That (Live)', releaseDiscogsId: 300 },
    ]);
    mockGetVersionCandidates.mockResolvedValue([group]);
    mockReleasesShareArtist.mockResolvedValue(true);

    const summary = await enrichTrackVersions(fakeDriver);

    // Two variants link to root (elementId 'a' from lowest releaseDiscogsId 100)
    expect(mockMergeVersionRelationships).toHaveBeenCalledWith(
      fakeDriver,
      expect.arrayContaining([
        expect.objectContaining({ fromElementId: 'b', toElementId: 'a', versionType: 'remix' }),
        expect.objectContaining({ fromElementId: 'c', toElementId: 'a', versionType: 'live' }),
      ]),
    );
    expect(summary.enriched).toBe(2);
    expect(summary.skipped).toBe(0);
  });

  it('skips groups where releases do not share an artist', async () => {
    const group = makeTracks('yesterday', [
      { elementId: 'x', title: 'Yesterday', releaseDiscogsId: 10 },
      { elementId: 'y', title: 'Yesterday (Cover)', releaseDiscogsId: 20 },
    ]);
    mockGetVersionCandidates.mockResolvedValue([group]);
    mockReleasesShareArtist.mockResolvedValue(false);

    const summary = await enrichTrackVersions(fakeDriver);

    expect(mockMergeVersionRelationships).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('counts failures per group and continues processing remaining groups', async () => {
    const group1 = makeTracks('song a', [
      { elementId: '1a', title: 'Song A', releaseDiscogsId: 1 },
      { elementId: '1b', title: 'Song A (Remix)', releaseDiscogsId: 2 },
    ]);
    const group2 = makeTracks('song b', [
      { elementId: '2a', title: 'Song B', releaseDiscogsId: 3 },
      { elementId: '2b', title: 'Song B (Live)', releaseDiscogsId: 4 },
    ]);
    mockGetVersionCandidates.mockResolvedValue([group1, group2]);
    mockReleasesShareArtist.mockResolvedValue(true);
    mockMergeVersionRelationships
      .mockRejectedValueOnce(new Error('Neo4j session error'))
      .mockResolvedValueOnce(undefined);

    const summary = await enrichTrackVersions(fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
  });

  it('includes all releases when overlap is found across multiple pairs', async () => {
    // Full pairwise: 10v20=false, 10v30=true, 20v30=true → all 3 in validated cluster.
    const group = makeTracks('find me', [
      { elementId: 'r1', title: 'Find Me', releaseDiscogsId: 10 },
      { elementId: 'r2', title: 'Find Me (Remix)', releaseDiscogsId: 20 },
      { elementId: 'r3', title: 'Find Me (Live)', releaseDiscogsId: 30 },
    ]);
    mockGetVersionCandidates.mockResolvedValue([group]);
    mockReleasesShareArtist
      .mockResolvedValueOnce(false) // 10 vs 20 — no overlap
      .mockResolvedValueOnce(true) // 10 vs 30 — overlap found (adds 10, 30)
      .mockResolvedValueOnce(true); // 20 vs 30 — overlap found (adds 20)

    const summary = await enrichTrackVersions(fakeDriver);

    expect(mockMergeVersionRelationships).toHaveBeenCalled();
    expect(summary.enriched).toBe(2);
    expect(summary.skipped).toBe(0);
  });

  it('excludes unrelated releases and uses validated cluster root', async () => {
    // Release 10 is unrelated (no shared artist with 20 or 30); 20↔30 share an artist.
    // Only tracks from releases 20 and 30 should be linked; root = release 20.
    const group = makeTracks('cross artist', [
      { elementId: 'r1', title: 'Cross Artist', releaseDiscogsId: 10 },
      { elementId: 'r2', title: 'Cross Artist (Remix)', releaseDiscogsId: 20 },
      { elementId: 'r3', title: 'Cross Artist (Live)', releaseDiscogsId: 30 },
    ]);
    mockGetVersionCandidates.mockResolvedValue([group]);
    mockReleasesShareArtist
      .mockResolvedValueOnce(false) // 10 vs 20 — no overlap
      .mockResolvedValueOnce(false) // 10 vs 30 — no overlap
      .mockResolvedValueOnce(true); // 20 vs 30 — overlap found

    const summary = await enrichTrackVersions(fakeDriver);

    expect(mockMergeVersionRelationships).toHaveBeenCalledWith(
      fakeDriver,
      expect.arrayContaining([expect.objectContaining({ fromElementId: 'r3', toElementId: 'r2' })]),
    );
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('returns failed=1 when getVersionCandidates throws', async () => {
    mockGetVersionCandidates.mockRejectedValue(new Error('DB connection failed'));

    const summary = await enrichTrackVersions(fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(0);
  });
});
