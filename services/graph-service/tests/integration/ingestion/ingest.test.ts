import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import type { DiscogsCollectionPage, DiscogsRelease } from '../../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — plain vi.fn() here; implementations set in beforeEach after
// JSON fixture imports have loaded. Using vi.hoisted() ensures these are ready
// when the vi.mock() factories below execute.
// ---------------------------------------------------------------------------
const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHasReleases = vi.hoisted(() => vi.fn());
const mockMergeReleaseGraph = vi.hoisted(() => vi.fn());
const mockGetCollectionReleases = vi.hoisted(() => vi.fn());
const mockGetRelease = vi.hoisted(() => vi.fn());
const mockEnrichLyrics = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ enriched: 0, skipped: 0, failed: 0, durationMs: 0 }),
);

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: mockHasReleases,
  mergeReleaseGraph: mockMergeReleaseGraph,
}));

vi.mock('../../../src/ingestion/discogs-client.js', () => ({
  DiscogsClient: vi.fn().mockImplementation(() => ({
    getCollectionReleases: mockGetCollectionReleases,
    getRelease: mockGetRelease,
  })),
}));

vi.mock('../../../src/enrichment/lyrics.js', () => ({
  enrichLyrics: mockEnrichLyrics,
}));

// ---------------------------------------------------------------------------
// Load fixtures (JSON). These are loaded after hoisted mocks run.
// ---------------------------------------------------------------------------
import collectionPage1 from '../../fixtures/collection-page-1.json' with { type: 'json' };
import release13570466 from '../../fixtures/release-13570466.json' with { type: 'json' };
import release9999991 from '../../fixtures/release-9999991.json' with { type: 'json' };
import release9999992 from '../../fixtures/release-9999992.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Discogs ingestion pipeline', () => {
  let app: FastifyInstance;

  const releaseMap: Record<number, unknown> = {
    13570466: release13570466,
    9999991: release9999991,
    9999992: release9999992,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default behaviours — graph is empty, all requests succeed
    mockHasReleases.mockResolvedValue(false);
    mockMergeReleaseGraph.mockResolvedValue(undefined);
    mockEnrichLyrics.mockResolvedValue({ enriched: 0, skipped: 0, failed: 0, durationMs: 0 });
    mockGetCollectionReleases.mockResolvedValue(collectionPage1 as DiscogsCollectionPage);
    mockGetRelease.mockImplementation((id: number) => {
      const r = releaseMap[id];
      if (!r) return Promise.reject(new Error(`No fixture for release ${id}`));
      return Promise.resolve(r);
    });

    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    process.env['DISCOGS_TOKEN'] = 'test-token';
    process.env['DISCOGS_USERNAME'] = 'testuser';
    process.env['DISCOGS_USER_AGENT'] = 'liner-notes/test';
    process.env['DISCOGS_REQUEST_DELAY_MS'] = '0';
  });

  afterEach(async () => {
    await app?.close();
  });

  // -------------------------------------------------------------------------
  // Auto-trigger behaviour (via server onReady hook)
  // -------------------------------------------------------------------------

  it('triggers ingestion automatically when the graph is empty', async () => {
    mockHasReleases.mockResolvedValue(false);
    app = await buildServer();
    await app.ready();

    // Fire-and-forget ingestion runs asynchronously — give it a tick to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockHasReleases).toHaveBeenCalledOnce();
    expect(mockGetCollectionReleases).toHaveBeenCalled();
  });

  it('does not trigger ingestion when the graph already has releases', async () => {
    mockHasReleases.mockResolvedValue(true);
    app = await buildServer();
    await app.ready();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockHasReleases).toHaveBeenCalledOnce();
    expect(mockGetCollectionReleases).not.toHaveBeenCalled();
    expect(mockMergeReleaseGraph).not.toHaveBeenCalled();
  });

  it('skips auto-ingestion when DISCOGS_TOKEN is not set', async () => {
    delete process.env['DISCOGS_TOKEN'];
    mockHasReleases.mockResolvedValue(false);
    app = await buildServer();
    await app.ready();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockMergeReleaseGraph).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Pipeline correctness (via runIngestion directly)
  // -------------------------------------------------------------------------

  it('calls mergeReleaseGraph for each release in the collection', async () => {
    const { runIngestion } = await import('../../../src/ingestion/ingest.js');
    const { DiscogsClient } = await import('../../../src/ingestion/discogs-client.js');
    const fakeDriver = {} as import('neo4j-driver').Driver;
    const client = new DiscogsClient({ token: 'test', userAgent: 'test', delayMs: 0 });

    const summary = await runIngestion(client, fakeDriver, { username: 'testuser' });

    // 3 releases in collection-page-1.json
    expect(summary.releasesProcessed).toBe(3);
    expect(summary.releasesFailed).toBe(0);
    expect(mockMergeReleaseGraph).toHaveBeenCalledTimes(3);

    const calledIds = mockMergeReleaseGraph.mock.calls.map(
      (call) => (call[1] as { id: number }).id,
    );
    expect(calledIds).toContain(13570466);
    expect(calledIds).toContain(9999991);
    expect(calledIds).toContain(9999992);
  });

  it('is idempotent: running the pipeline twice processes the same number of releases each run', async () => {
    const { runIngestion } = await import('../../../src/ingestion/ingest.js');
    const { DiscogsClient } = await import('../../../src/ingestion/discogs-client.js');
    const fakeDriver = {} as import('neo4j-driver').Driver;
    const client = new DiscogsClient({ token: 'test', userAgent: 'test', delayMs: 0 });

    const summary1 = await runIngestion(client, fakeDriver, { username: 'testuser' });
    const summary2 = await runIngestion(client, fakeDriver, { username: 'testuser' });

    // Idempotency: same number of releases processed each run
    expect(summary1.releasesProcessed).toBe(summary2.releasesProcessed);
    expect(summary1.releasesFailed).toBe(0);
    expect(summary2.releasesFailed).toBe(0);
  });

  it('continues processing remaining releases when one release fails', async () => {
    mockGetRelease.mockImplementation((id: number) => {
      if (id === 9999991) {
        return Promise.reject(new Error('API error for release 9999991'));
      }
      const r = releaseMap[id];
      if (!r) return Promise.reject(new Error(`No fixture for ${id}`));
      return Promise.resolve(r);
    });

    const { runIngestion } = await import('../../../src/ingestion/ingest.js');
    const { DiscogsClient } = await import('../../../src/ingestion/discogs-client.js');
    const fakeDriver = {} as import('neo4j-driver').Driver;
    const client = new DiscogsClient({ token: 'test', userAgent: 'test', delayMs: 0 });

    const summary = await runIngestion(client, fakeDriver, { username: 'testuser' });

    expect(summary.releasesProcessed).toBe(2); // 13570466 and 9999992 succeeded
    expect(summary.releasesFailed).toBe(1); // 9999991 failed
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain('9999991');
  });

  it('paginates through multiple collection pages', async () => {
    const page1WithMore: DiscogsCollectionPage = {
      ...collectionPage1,
      pagination: { ...collectionPage1.pagination, pages: 2 },
    } as DiscogsCollectionPage;

    const page2: DiscogsCollectionPage = {
      pagination: { page: 2, pages: 2, per_page: 50, items: 4, urls: {} },
      releases: [
        {
          id: 9999992,
          instance_id: 2001,
          date_added: '2023-01-01T00:00:00-00:00',
          rating: 0,
          basic_information: {
            id: 9999992,
            title: 'Simple Album',
            year: 1984,
          } as DiscogsCollectionPage['releases'][0]['basic_information'],
        },
      ],
    };

    mockGetCollectionReleases.mockResolvedValueOnce(page1WithMore).mockResolvedValueOnce(page2);

    const { runIngestion } = await import('../../../src/ingestion/ingest.js');
    const { DiscogsClient } = await import('../../../src/ingestion/discogs-client.js');
    const fakeDriver = {} as import('neo4j-driver').Driver;
    const client = new DiscogsClient({ token: 'test', userAgent: 'test', delayMs: 0 });

    await runIngestion(client, fakeDriver, { username: 'testuser' });

    // Both pages must be fetched
    expect(mockGetCollectionReleases).toHaveBeenCalledTimes(2);
    expect(mockGetCollectionReleases).toHaveBeenNthCalledWith(1, 'testuser', 1, 50);
    expect(mockGetCollectionReleases).toHaveBeenNthCalledWith(2, 'testuser', 2, 50);
  });
});
