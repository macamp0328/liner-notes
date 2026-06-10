import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';
import { resetAllPipelineStates } from '../../../src/api/admin.js';
import type { IngestionSummary } from '../../../src/ingestion/ingest.js';
import type { JobState } from '../../../src/ingestion/job-state.js';

// ── module mocks ──────────────────────────────────────────────────────────
const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

const mockClearGeniusLyrics = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/lyrics-repository.js', () => ({
  clearGeniusLyrics: mockClearGeniusLyrics,
}));

const mockEnrichLyrics = vi.hoisted(() => vi.fn());
vi.mock('../../../src/enrichment/lyrics.js', () => ({
  enrichLyrics: mockEnrichLyrics,
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/job-repository.js', () => ({
  findResumableReloadJob: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

const mockRunIngestion = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ingestion/ingest.js', () => ({
  runIngestion: mockRunIngestion,
  buildDiscogsClientFromEnv: vi.fn().mockReturnValue({ getCollectionReleases: vi.fn() }),
}));

const mockEnrichTrackAcousticBrainz = vi.hoisted(() => vi.fn());
vi.mock('../../../src/enrichment/track-acousticbrainz.js', () => ({
  enrichTrackAcousticBrainz: mockEnrichTrackAcousticBrainz,
}));

const mockResetTrackAcousticBrainzEnrichment = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/track-acousticbrainz-repository.js', () => ({
  resetTrackAcousticBrainzEnrichment: mockResetTrackAcousticBrainzEnrichment,
}));

vi.mock('../../../src/ingestion/acousticbrainz-client.js', () => ({
  buildAcousticBrainzClientFromEnv: vi.fn().mockReturnValue({}),
}));

const mockEnrichTrackDeezer = vi.hoisted(() => vi.fn());
vi.mock('../../../src/enrichment/track-deezer.js', () => ({
  enrichTrackDeezer: mockEnrichTrackDeezer,
}));

const mockResetTrackDeezerEnrichment = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/track-deezer-repository.js', () => ({
  resetTrackDeezerEnrichment: mockResetTrackDeezerEnrichment,
}));

vi.mock('../../../src/ingestion/deezer-client.js', () => ({
  buildDeezerClientFromEnv: vi.fn().mockReturnValue({}),
}));

const mockEnrichArtistProfiles = vi.hoisted(() => vi.fn());
vi.mock('../../../src/enrichment/artist-profiles.js', () => ({
  enrichArtistProfiles: mockEnrichArtistProfiles,
}));

const mockResetArtistProfilesEnrichment = vi.hoisted(() => vi.fn());
vi.mock('../../../src/db/artist-profiles-repository.js', () => ({
  resetArtistProfilesEnrichment: mockResetArtistProfilesEnrichment,
}));

const mockEnrichArtistGenres = vi.hoisted(() => vi.fn());
vi.mock('../../../src/enrichment/artist-genres.js', () => ({
  enrichArtistGenres: mockEnrichArtistGenres,
}));

const mockEnrichNationality = vi.hoisted(() => vi.fn());
vi.mock('../../../src/enrichment/artist-nationality.js', () => ({
  enrichNationality: mockEnrichNationality,
}));

// job-state is mocked so integration tests don't share singleton state
const mockGetJobState = vi.hoisted(() => vi.fn());
const mockStartJob = vi.hoisted(() => vi.fn().mockReturnValue('test-job-id'));
const mockCompleteJob = vi.hoisted(() => vi.fn());
const mockFailJob = vi.hoisted(() => vi.fn());

vi.mock('../../../src/ingestion/job-state.js', () => ({
  getJobState: mockGetJobState,
  startJob: mockStartJob,
  completeJob: mockCompleteJob,
  failJob: mockFailJob,
}));

// ── helpers ───────────────────────────────────────────────────────────────
const VALID_TOKEN = 'test-admin-token';

// Since #280 the /enrich routes are fire-and-forget: they return 202 and the run settles
// on a later microtask. Drain that queue before polling /status (so lastResult/lastError/
// running reflect the finished run) and before a test ends (so a still-pending run can't
// mutate the shared per-pipeline state object the next test reuses via resetAllPipelineStates).
const flushBackground = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A fully-populated nationality summary including the per-source counts. Used to guard
// against the Fastify response schema silently stripping the per-source fields.
const nationalitySummary = {
  enriched: 7,
  skipped: 2,
  failed: 0,
  durationMs: 1234,
  resolvedByMusicbrainz: 4,
  resolvedByWikidata: 2,
};

const completeSummary: IngestionSummary = {
  releasesProcessed: 10,
  releasesFailed: 0,
  errors: [],
  durationMs: 5000,
  lyricsEnrichment: { enriched: 8, skipped: 2, failed: 0, durationMs: 1000 },
  masterDataEnrichment: { enriched: 5, skipped: 2, failed: 0, durationMs: 500 },
  artistGenresEnrichment: {
    genresEnriched: 10,
    stylesEnriched: 9,
    skipped: 0,
    failed: 0,
    durationMs: 200,
  },
  artistProfilesEnrichment: { enriched: 8, skipped: 2, failed: 0, durationMs: 8000 },
};

const idleState: JobState = {
  status: 'idle',
  jobId: '',
  startedAt: null,
  completedAt: null,
  durationMs: null,
  stats: null,
};

const runningState: JobState = {
  status: 'running',
  jobId: 'test-job-id',
  startedAt: '2026-05-07T12:00:00.000Z',
  completedAt: null,
  durationMs: null,
  stats: null,
};

const completeState: JobState = {
  status: 'complete',
  jobId: 'test-job-id',
  startedAt: '2026-05-07T12:00:00.000Z',
  completedAt: '2026-05-07T12:01:00.000Z',
  durationMs: 60000,
  stats: {
    nodes: {},
    relationships: {},
    lyricsEnriched: 8,
    lyricsSkipped: 2,
    lyricsFailed: 0,
    errorCount: 0,
    errors: [],
  },
};

describe('Admin API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    process.env['ADMIN_TOKEN'] = VALID_TOKEN;
    process.env['DISCOGS_USERNAME'] = 'testuser';
    mockVerifyConnectivity.mockResolvedValue(undefined);
    mockRunIngestion.mockResolvedValue(completeSummary);
    mockGetJobState.mockReturnValue(idleState);
    mockStartJob.mockReturnValue('test-job-id');
    mockClearGeniusLyrics.mockResolvedValue(460);
    mockEnrichLyrics.mockResolvedValue({ enriched: 10, skipped: 5, failed: 0, durationMs: 3000 });
    mockEnrichTrackAcousticBrainz.mockResolvedValue({
      tracksProcessed: 5,
      tracksSkipped: 2,
      tracksFailed: 0,
      durationMs: 1200,
    });
    mockResetTrackAcousticBrainzEnrichment.mockResolvedValue(7);
    mockEnrichTrackDeezer.mockResolvedValue({
      tracksProcessed: 3,
      tracksSkipped: 1,
      tracksFailed: 0,
      durationMs: 800,
    });
    mockResetTrackDeezerEnrichment.mockResolvedValue(4);
    mockEnrichArtistProfiles.mockResolvedValue({
      enriched: 12,
      skipped: 3,
      failed: 0,
      durationMs: 9000,
    });
    mockResetArtistProfilesEnrichment.mockResolvedValue(15);
    mockEnrichArtistGenres.mockResolvedValue({
      genresEnriched: 20,
      stylesEnriched: 18,
      skipped: 0,
      failed: 0,
      durationMs: 300,
    });
    mockEnrichNationality.mockResolvedValue(nationalitySummary);
    resetAllPipelineStates();
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env['ADMIN_TOKEN'];
    delete process.env['DISCOGS_USERNAME'];
    delete process.env['MUSICBRAINZ_USER_AGENT'];
  });

  // ── POST /ingest ─────────────────────────────────────────────────────────
  describe('POST /api/v1/admin/ingest', () => {
    it('returns 202 with jobId when called with valid token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as { data: { jobId: string; message: string } };
      expect(body.data.jobId).toBe('test-job-id');
      expect(body.data.message).toBe('Ingestion started');
    });

    it('returns 202 when no body is sent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(202);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when token is wrong', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest',
        headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 409 when a job is already running', async () => {
      mockGetJobState.mockReturnValue(runningState);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.payload) as {
        error: { code: string; message: string; jobId: string };
      };
      expect(body.error.code).toBe('JOB_RUNNING');
      expect(body.error.jobId).toBe('test-job-id');
    });
  });

  // ── GET /ingest/status ───────────────────────────────────────────────────
  describe('GET /api/v1/admin/ingest/status', () => {
    it('returns 200 with idle status before any job has run', async () => {
      mockGetJobState.mockReturnValue(idleState);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { data: { status: string } };
      expect(body.data.status).toBe('idle');
    });

    it('returns 200 with complete status and stats after a job finishes', async () => {
      mockGetJobState.mockReturnValue(completeState);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { status: string; stats: { lyricsEnriched: number } };
      };
      expect(body.data.status).toBe('complete');
      expect(body.data.stats.lyricsEnriched).toBe(8);
    });

    it('returns 401 when token is invalid', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ingest/status',
        headers: { authorization: 'Bearer bad' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── POST /lyrics/clear-genius ─────────────────────────────────────────────
  describe('POST /api/v1/admin/lyrics/clear-genius', () => {
    it('returns 200 with count of cleared tracks', async () => {
      mockClearGeniusLyrics.mockResolvedValueOnce(460);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/clear-genius',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { data: { cleared: number } };
      expect(body.data.cleared).toBe(460);
    });

    it('returns 200 with cleared: 0 when no Genius tracks exist', async () => {
      mockClearGeniusLyrics.mockResolvedValueOnce(0);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/clear-genius',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { data: { cleared: number } };
      expect(body.data.cleared).toBe(0);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/clear-genius',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when token is wrong', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/clear-genius',
        headers: { authorization: 'Bearer wrong-token' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /lyrics/status ───────────────────────────────────────────────────
  describe('GET /api/v1/admin/lyrics/status', () => {
    it('returns 200 with running:false and null lastResult/lastError before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/lyrics/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown; lastError: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
      // lastError must be present in the schema (#280) — else Fastify strips it.
      expect(body.data.lastError).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/lyrics/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── POST /lyrics/enrich ───────────────────────────────────────────────────
  describe('POST /api/v1/admin/lyrics/enrich', () => {
    it('returns 202 and starts the run in the background when called with valid token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as {
        data: { message: string; statusUrl: string };
      };
      expect(body.data.message).toContain('started');
      expect(body.data.statusUrl).toBe('/api/v1/admin/lyrics/status');
      await flushBackground();
    });

    it('returns 401 when Authorization header is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/enrich',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 401 when token is wrong', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/enrich',
        headers: { authorization: 'Bearer wrong-token' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 503 when ADMIN_TOKEN is not configured', async () => {
      delete process.env['ADMIN_TOKEN'];

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('populates lastResult on /status once the background run completes', async () => {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(accepted.statusCode).toBe(202);
      await flushBackground();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/lyrics/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: { enriched: number }; lastError: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).not.toBeNull();
      expect(body.data.lastResult?.enriched).toBe(10);
      expect(body.data.lastError).toBeNull();
    });

    it('records lastError on /status when the background run throws', async () => {
      // Reject with a non-Error to exercise the String(err) branch of the catch.
      mockEnrichLyrics.mockRejectedValueOnce('boom');

      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/lyrics/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(accepted.statusCode).toBe(202);
      await flushBackground();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/lyrics/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown; lastError: string | null };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
      expect(body.data.lastError).toBe('boom');
    });

    it('returns 409 when enrichment is already in progress', async () => {
      // Hold the first run open with a deferred so the second request arrives mid-run.
      let release!: (value: {
        enriched: number;
        skipped: number;
        failed: number;
        durationMs: number;
      }) => void;
      mockEnrichLyrics.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/lyrics/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/lyrics/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
      ]);

      const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
      expect(codes).toEqual([202, 409]);

      const body409 = r1.statusCode === 409 ? r1 : r2;
      const parsed = JSON.parse(body409.payload) as { error: { code: string } };
      expect(parsed.error.code).toBe('ENRICHMENT_RUNNING');

      release({ enriched: 0, skipped: 0, failed: 0, durationMs: 0 });
      await flushBackground();
    });
  });

  // ── POST /nationality/enrich ──────────────────────────────────────────────
  describe('POST /api/v1/admin/nationality/enrich', () => {
    it('returns 202 and starts the run in the background', async () => {
      process.env['MUSICBRAINZ_USER_AGENT'] = 'liner-notes/test (test@example.com)';
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/nationality/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as { data: { message: string; statusUrl: string } };
      expect(body.data.message).toContain('started');
      expect(body.data.statusUrl).toBe('/api/v1/admin/nationality/status');
      await flushBackground();
    });

    it('surfaces the full instrumented summary as lastResult on /nationality/status after a run', async () => {
      process.env['MUSICBRAINZ_USER_AGENT'] = 'liner-notes/test (test@example.com)';
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/nationality/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(accepted.statusCode).toBe(202);
      await flushBackground();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nationality/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: Record<string, number> | null };
      };
      expect(body.data.running).toBe(false);
      // toEqual (not toMatchObject): the /status lastResult schema must expose every per-source
      // field, and Fastify strips any property not declared in the schema — so a missing field
      // here means the schema regressed. (Since #280 this is the sole guard against that, as the
      // enrich response no longer carries the summary.)
      expect(body.data.lastResult).toEqual(nationalitySummary);
    });

    it('returns 503 when MUSICBRAINZ_USER_AGENT is not configured', async () => {
      delete process.env['MUSICBRAINZ_USER_AGENT'];
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/nationality/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(503);
    });
  });

  // ── GET /nationality/status ───────────────────────────────────────────────
  describe('GET /api/v1/admin/nationality/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nationality/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/nationality/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /master-data/status ───────────────────────────────────────────────
  describe('GET /api/v1/admin/master-data/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/master-data/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/master-data/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /mb-release-events/status ────────────────────────────────────────
  describe('GET /api/v1/admin/mb-release-events/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/mb-release-events/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/mb-release-events/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /track-musicbrainz/status ────────────────────────────────────────
  describe('GET /api/v1/admin/track-musicbrainz/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/track-musicbrainz/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/track-musicbrainz/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── POST /track-acousticbrainz/enrich ────────────────────────────────────
  describe('POST /api/v1/admin/track-acousticbrainz/enrich', () => {
    it('returns 202 and starts the run in the background on success', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-acousticbrainz/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as { data: { message: string; statusUrl: string } };
      expect(body.data.message).toContain('started');
      expect(body.data.statusUrl).toBe('/api/v1/admin/track-acousticbrainz/status');
      await flushBackground();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-acousticbrainz/enrich',
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 409 when enrichment is already in progress', async () => {
      let release!: (value: {
        tracksProcessed: number;
        tracksSkipped: number;
        tracksFailed: number;
        durationMs: number;
      }) => void;
      mockEnrichTrackAcousticBrainz.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/track-acousticbrainz/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/track-acousticbrainz/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
      ]);

      const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
      expect(codes).toEqual([202, 409]);
      const body409 = r1.statusCode === 409 ? r1 : r2;
      const parsed = JSON.parse(body409.payload) as { error: { code: string } };
      expect(parsed.error.code).toBe('ENRICHMENT_RUNNING');

      release({ tracksProcessed: 0, tracksSkipped: 0, tracksFailed: 0, durationMs: 0 });
      await flushBackground();
    });
  });

  // ── POST /track-acousticbrainz/reset ─────────────────────────────────────
  describe('POST /api/v1/admin/track-acousticbrainz/reset', () => {
    it('returns 200 with count of reset tracks', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-acousticbrainz/reset',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { data: { reset: number } };
      expect(body.data.reset).toBe(7);
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-acousticbrainz/reset',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /track-acousticbrainz/status ─────────────────────────────────────
  describe('GET /api/v1/admin/track-acousticbrainz/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/track-acousticbrainz/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/track-acousticbrainz/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── POST /track-deezer/enrich ─────────────────────────────────────────────
  describe('POST /api/v1/admin/track-deezer/enrich', () => {
    it('returns 202 and starts the run in the background on success', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-deezer/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as { data: { message: string; statusUrl: string } };
      expect(body.data.message).toContain('started');
      expect(body.data.statusUrl).toBe('/api/v1/admin/track-deezer/status');
      await flushBackground();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-deezer/enrich',
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 409 when enrichment is already in progress', async () => {
      let release!: (value: {
        tracksProcessed: number;
        tracksSkipped: number;
        tracksFailed: number;
        durationMs: number;
      }) => void;
      mockEnrichTrackDeezer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/track-deezer/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/track-deezer/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
      ]);

      const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
      expect(codes).toEqual([202, 409]);
      const body409 = r1.statusCode === 409 ? r1 : r2;
      const parsed = JSON.parse(body409.payload) as { error: { code: string } };
      expect(parsed.error.code).toBe('ENRICHMENT_RUNNING');

      release({ tracksProcessed: 0, tracksSkipped: 0, tracksFailed: 0, durationMs: 0 });
      await flushBackground();
    });
  });

  // ── POST /track-deezer/reset ──────────────────────────────────────────────
  describe('POST /api/v1/admin/track-deezer/reset', () => {
    it('returns 200 with count of reset tracks', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-deezer/reset',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { data: { reset: number } };
      expect(body.data.reset).toBe(4);
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/track-deezer/reset',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /track-deezer/status ──────────────────────────────────────────────
  describe('GET /api/v1/admin/track-deezer/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/track-deezer/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/track-deezer/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── POST /artist-profiles/enrich ─────────────────────────────────────────
  describe('POST /api/v1/admin/artist-profiles/enrich', () => {
    it('returns 202 and starts the run in the background on success', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-profiles/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as { data: { message: string; statusUrl: string } };
      expect(body.data.message).toContain('started');
      expect(body.data.statusUrl).toBe('/api/v1/admin/artist-profiles/status');
      await flushBackground();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-profiles/enrich',
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 409 when enrichment is already in progress', async () => {
      let release!: (value: {
        enriched: number;
        skipped: number;
        failed: number;
        durationMs: number;
      }) => void;
      mockEnrichArtistProfiles.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/artist-profiles/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/artist-profiles/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
      ]);

      const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
      expect(codes).toEqual([202, 409]);
      const body409 = r1.statusCode === 409 ? r1 : r2;
      const parsed = JSON.parse(body409.payload) as { error: { code: string } };
      expect(parsed.error.code).toBe('ENRICHMENT_RUNNING');

      release({ enriched: 0, skipped: 0, failed: 0, durationMs: 0 });
      await flushBackground();
    });
  });

  // ── POST /artist-profiles/reset ──────────────────────────────────────────
  describe('POST /api/v1/admin/artist-profiles/reset', () => {
    it('returns 200 with count of reset artists', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-profiles/reset',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { data: { reset: number } };
      expect(body.data.reset).toBe(15);
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-profiles/reset',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── GET /artist-profiles/status ──────────────────────────────────────────
  describe('GET /api/v1/admin/artist-profiles/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/artist-profiles/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/artist-profiles/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ── POST /artist-genres/enrich ───────────────────────────────────────────
  describe('POST /api/v1/admin/artist-genres/enrich', () => {
    it('returns 202 and starts the run in the background on success', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-genres/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.payload) as { data: { message: string; statusUrl: string } };
      expect(body.data.message).toContain('started');
      expect(body.data.statusUrl).toBe('/api/v1/admin/artist-genres/status');
      await flushBackground();
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-genres/enrich',
      });
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 409 when enrichment is already in progress', async () => {
      let release!: (value: {
        genresEnriched: number;
        stylesEnriched: number;
        skipped: number;
        failed: number;
        durationMs: number;
      }) => void;
      mockEnrichArtistGenres.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/artist-genres/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/artist-genres/enrich',
          headers: { authorization: `Bearer ${VALID_TOKEN}` },
        }),
      ]);

      const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
      expect(codes).toEqual([202, 409]);
      const body409 = r1.statusCode === 409 ? r1 : r2;
      const parsed = JSON.parse(body409.payload) as { error: { code: string } };
      expect(parsed.error.code).toBe('ENRICHMENT_RUNNING');

      release({ genresEnriched: 0, stylesEnriched: 0, skipped: 0, failed: 0, durationMs: 0 });
      await flushBackground();
    });
  });

  // ── GET /artist-genres/status ────────────────────────────────────────────
  describe('GET /api/v1/admin/artist-genres/status', () => {
    it('returns 200 with running:false and null lastResult before any run', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/artist-genres/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { running: boolean; lastResult: unknown };
      };
      expect(body.data.running).toBe(false);
      expect(body.data.lastResult).toBeNull();
    });

    it('returns the genres/styles summary in lastResult after a successful run', async () => {
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/artist-genres/enrich',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(accepted.statusCode).toBe(202);
      await flushBackground();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/artist-genres/status',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        data: { lastResult: { genresEnriched: number; stylesEnriched: number } | null };
      };
      expect(body.data.lastResult?.genresEnriched).toBe(20);
      expect(body.data.lastResult?.stylesEnriched).toBe(18);
    });

    it('returns 401 when token is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/artist-genres/status',
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
