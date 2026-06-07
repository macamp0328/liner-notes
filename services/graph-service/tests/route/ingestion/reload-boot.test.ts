import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import type { IngestionSummary } from '../../../src/ingestion/ingest.js';

const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

const mockHasReleases = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: mockHasReleases,
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

const mockRunIngestion = vi.hoisted(() => vi.fn());
const mockBuildDiscogsClient = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ingestion/ingest.js', () => ({
  runIngestion: mockRunIngestion,
  ingestReleases: vi.fn(),
  buildDiscogsClientFromEnv: mockBuildDiscogsClient,
}));

const mockRunReload = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ingestion/orchestrator.js', () => ({ runReload: mockRunReload }));

const mockFindResumable = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/job-repository.js', () => ({
  findResumableReloadJob: mockFindResumable,
}));

const completeSummary: IngestionSummary = {
  releasesProcessed: 1,
  releasesFailed: 0,
  errors: [],
  durationMs: 1,
  lyricsEnrichment: { enriched: 0, skipped: 0, failed: 0, durationMs: 0 },
  masterDataEnrichment: { enriched: 0, skipped: 0, failed: 0, durationMs: 0 },
  artistGenresEnrichment: {
    genresEnriched: 0,
    stylesEnriched: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
  },
  artistProfilesEnrichment: { enriched: 0, skipped: 0, failed: 0, durationMs: 0 },
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('cold-start reload resume (onReady)', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyConnectivity.mockResolvedValue(undefined);
    mockHasReleases.mockResolvedValue(true);
    mockRunIngestion.mockResolvedValue(completeSummary);
    mockRunReload.mockResolvedValue({ jobId: 'job-9', status: 'complete' });
    mockFindResumable.mockResolvedValue(null);
    mockBuildDiscogsClient.mockReturnValue({ getCollectionReleases: vi.fn() });

    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    process.env['DISCOGS_TOKEN'] = 'test-token';
    process.env['DISCOGS_USERNAME'] = 'testuser';
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    delete process.env['DISCOGS_USERNAME'];
  });

  it('resumes an interrupted reload and skips the empty-graph safety net', async () => {
    mockFindResumable.mockResolvedValue({ jobId: 'job-9', status: 'running', stages: [] });

    app = await buildServer();
    await app.ready();
    await tick();

    expect(mockRunReload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'testuser', resumeJobId: 'job-9' }),
    );
    // The empty-graph safety net is not consulted when resuming.
    expect(mockHasReleases).not.toHaveBeenCalled();
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });

  it('does not resume when DISCOGS_USERNAME is unset (and does not fall through to ingest)', async () => {
    mockFindResumable.mockResolvedValue({ jobId: 'job-9', status: 'running', stages: [] });
    delete process.env['DISCOGS_USERNAME'];

    app = await buildServer();
    await app.ready();
    await tick();

    expect(mockRunReload).not.toHaveBeenCalled();
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });

  it('does not resume when the Discogs client is unusable (e.g. DISCOGS_TOKEN unset)', async () => {
    mockFindResumable.mockResolvedValue({ jobId: 'job-9', status: 'running', stages: [] });
    mockBuildDiscogsClient.mockReturnValue(null);

    app = await buildServer();
    await app.ready();
    await tick();

    expect(mockRunReload).not.toHaveBeenCalled();
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });

  it('falls through to the empty-graph safety net when there is no interrupted job', async () => {
    mockFindResumable.mockResolvedValue(null);
    mockHasReleases.mockResolvedValue(false);

    app = await buildServer();
    await app.ready();
    await tick();

    expect(mockRunReload).not.toHaveBeenCalled();
    expect(mockHasReleases).toHaveBeenCalledOnce();
    expect(mockRunIngestion).toHaveBeenCalledOnce();
  });

  it('does not check for a resumable job when autoIngest is disabled', async () => {
    mockFindResumable.mockResolvedValue({ jobId: 'job-9', status: 'running', stages: [] });

    app = await buildServer({ autoIngest: false });
    await app.ready();
    await tick();

    expect(mockFindResumable).not.toHaveBeenCalled();
    expect(mockRunReload).not.toHaveBeenCalled();
  });
});
