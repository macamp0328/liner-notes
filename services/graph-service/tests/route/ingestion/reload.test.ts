import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import { __resetReloadProgress } from '../../../src/ingestion/reload-progress.js';

const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/ingestion/ingest.js', () => ({
  runIngestion: vi.fn(),
  ingestReleases: vi.fn(),
  buildDiscogsClientFromEnv: vi.fn().mockReturnValue({ getCollectionReleases: vi.fn() }),
}));

const mockRunReload = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ingestion/orchestrator.js', () => ({ runReload: mockRunReload }));

const repo = vi.hoisted(() => ({
  createReloadJob: vi.fn(),
  findResumableReloadJob: vi.fn(),
  getLatestReloadJob: vi.fn(),
}));
vi.mock('../../../src/db/job-repository.js', () => repo);

const VALID_TOKEN = 'test-admin-token';

const sampleJob = {
  jobId: 'job-1',
  status: 'running' as const,
  startedAt: '2026-06-05T00:00:00Z',
  completedAt: null,
  durationMs: null,
  stages: [
    {
      stage: 'releases',
      ordinal: 0,
      status: 'complete' as const,
      startedAt: '2026-06-05T00:00:01Z',
      completedAt: '2026-06-05T00:00:09Z',
      counts: { releasesProcessed: 3 },
      error: null,
    },
    {
      stage: 'lyrics',
      ordinal: 1,
      status: 'running' as const,
      startedAt: '2026-06-05T00:00:10Z',
      completedAt: null,
      counts: {},
      error: null,
    },
  ],
};

describe('Reload admin API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    // POST /reload now flags the reload active synchronously (#281 fix); runReload is mocked here
    // and never clears it, so reset the real reload-progress singleton between tests.
    __resetReloadProgress();
    mockVerifyConnectivity.mockResolvedValue(undefined);
    mockRunReload.mockResolvedValue({
      jobId: 'job-new',
      status: 'complete',
      stagesRun: 12,
      stagesSkipped: 0,
      stagesFailed: 0,
    });
    repo.createReloadJob.mockResolvedValue('job-new');
    repo.findResumableReloadJob.mockResolvedValue(null);
    repo.getLatestReloadJob.mockResolvedValue(null);

    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    process.env['ADMIN_TOKEN'] = VALID_TOKEN;
    process.env['DISCOGS_TOKEN'] = 'test-token';
    process.env['DISCOGS_USERNAME'] = 'testuser';
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env['ADMIN_TOKEN'];
    delete process.env['DISCOGS_TOKEN'];
    delete process.env['DISCOGS_USERNAME'];
  });

  describe('POST /api/v1/admin/reload', () => {
    it('returns 202 with the jobId and kicks off the orchestrator', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reload',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.payload) as { data: { jobId: string; message: string } };
      expect(body.data.jobId).toBe('job-new');
      expect(body.data.message).toBe('Reload started');
      expect(repo.createReloadJob).toHaveBeenCalledOnce();
      expect(mockRunReload).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ username: 'testuser', resumeJobId: 'job-new' }),
      );
    });

    it('returns 409 when a reload is already in progress and does not start another', async () => {
      repo.findResumableReloadJob.mockResolvedValue({ ...sampleJob, jobId: 'running-7' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reload',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload) as { error: { code: string; jobId: string } };
      expect(body.error.code).toBe('RELOAD_RUNNING');
      expect(body.error.jobId).toBe('running-7');
      expect(repo.createReloadJob).not.toHaveBeenCalled();
      expect(mockRunReload).not.toHaveBeenCalled();
    });

    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/admin/reload' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 503 when DISCOGS_USERNAME is unset', async () => {
      delete process.env['DISCOGS_USERNAME'];
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/reload',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(res.statusCode).toBe(503);
      expect(mockRunReload).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/admin/reload/status', () => {
    it('returns the latest reload job with per-stage state', async () => {
      repo.getLatestReloadJob.mockResolvedValue(sampleJob);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/reload/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { data: typeof sampleJob };
      expect(body.data.jobId).toBe('job-1');
      expect(body.data.stages).toHaveLength(2);
      expect(body.data.stages[0]?.counts).toEqual({ releasesProcessed: 3 });
    });

    it('returns data: null when no reload has ever run', async () => {
      repo.getLatestReloadJob.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/reload/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { data: unknown };
      expect(body.data).toBeNull();
    });

    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/reload/status' });
      expect(res.statusCode).toBe(401);
    });
  });
});
