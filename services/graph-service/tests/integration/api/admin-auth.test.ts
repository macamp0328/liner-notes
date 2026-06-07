import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { snapshotEnv, type EnvSnapshot } from '../../helpers/env.js';

const TEST_TOKEN = 'test-admin-token-integration';

// Auth-relevant env the suite owns: snapshot once, clear to a baseline before each
// test, restore at the end. MUSICBRAINZ_USER_AGENT is included so the nationality
// 503-when-unset case below needs no inline bookkeeping.
const MANAGED_ENV_KEYS = [
  'ADMIN_TOKEN',
  'DISCOGS_TOKEN',
  'DISCOGS_USERNAME',
  'MUSICBRAINZ_USER_AGENT',
];

// Admin routes the auth contract must hold across — every admin endpoint
// registered by adminRoutes. We exercise GET and POST shapes per route.
// Order is irrelevant; the goal is full coverage of the admin surface.
const ADMIN_ROUTES: { method: 'GET' | 'POST'; url: string }[] = [
  { method: 'POST', url: '/api/v1/admin/ingest' },
  { method: 'GET', url: '/api/v1/admin/ingest/status' },
  { method: 'POST', url: '/api/v1/admin/reset' },
  { method: 'POST', url: '/api/v1/admin/lyrics/enrich' },
  { method: 'POST', url: '/api/v1/admin/lyrics/clear-genius' },
  { method: 'GET', url: '/api/v1/admin/lyrics/status' },
  { method: 'POST', url: '/api/v1/admin/nationality/enrich' },
  { method: 'POST', url: '/api/v1/admin/nationality/reset' },
  { method: 'GET', url: '/api/v1/admin/nationality/status' },
  { method: 'POST', url: '/api/v1/admin/master-data/enrich' },
  { method: 'GET', url: '/api/v1/admin/master-data/status' },
  { method: 'POST', url: '/api/v1/admin/mb-release-events/enrich' },
  { method: 'POST', url: '/api/v1/admin/mb-release-events/reset' },
  { method: 'GET', url: '/api/v1/admin/mb-release-events/status' },
  { method: 'POST', url: '/api/v1/admin/track-musicbrainz/enrich' },
  { method: 'POST', url: '/api/v1/admin/track-musicbrainz/reset' },
  { method: 'GET', url: '/api/v1/admin/track-musicbrainz/status' },
  { method: 'POST', url: '/api/v1/admin/track-acousticbrainz/enrich' },
  { method: 'POST', url: '/api/v1/admin/track-acousticbrainz/reset' },
  { method: 'GET', url: '/api/v1/admin/track-acousticbrainz/status' },
  { method: 'POST', url: '/api/v1/admin/track-deezer/enrich' },
  { method: 'POST', url: '/api/v1/admin/track-deezer/reset' },
  { method: 'GET', url: '/api/v1/admin/track-deezer/status' },
  { method: 'POST', url: '/api/v1/admin/artist-profiles/enrich' },
  { method: 'POST', url: '/api/v1/admin/artist-profiles/reset' },
  { method: 'GET', url: '/api/v1/admin/artist-profiles/status' },
  { method: 'POST', url: '/api/v1/admin/artist-genres/enrich' },
  { method: 'GET', url: '/api/v1/admin/artist-genres/status' },
  { method: 'POST', url: '/api/v1/admin/reload' },
  { method: 'GET', url: '/api/v1/admin/reload/status' },
];

// Status routes only — safe to call with a valid token because they touch
// in-memory state and do not trigger network I/O.
const STATUS_ROUTES = ADMIN_ROUTES.filter((r) => r.url.endsWith('/status'));

describe('admin auth contract', () => {
  let app: FastifyInstance;
  let envSnapshot: EnvSnapshot;

  beforeAll(async () => {
    app = await buildTestServer();
    // The graph is irrelevant to auth — keep it empty so status routes are
    // cheap and no test that touches data accidentally depends on seed state.
    await clearGraph(getDriver());
    envSnapshot = snapshotEnv(MANAGED_ENV_KEYS);
  });

  afterAll(async () => {
    envSnapshot.restore();
    await app.close();
  });

  beforeEach(() => {
    // Reset auth-related env to a known baseline before each test.
    envSnapshot.clear();
  });

  describe('when ADMIN_TOKEN is unset', () => {
    it.each(ADMIN_ROUTES)('returns 503 for $method $url', async ({ method, url }) => {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload)).toEqual({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Admin token not configured' },
      });
    });
  });

  describe('when ADMIN_TOKEN is set', () => {
    beforeEach(() => {
      process.env['ADMIN_TOKEN'] = TEST_TOKEN;
    });

    it.each(ADMIN_ROUTES)(
      'returns 401 without an Authorization header for $method $url',
      async ({ method, url }) => {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload)).toEqual({
          error: { code: 'UNAUTHORIZED', message: 'Valid ADMIN_TOKEN bearer token required' },
        });
      },
    );

    it.each(ADMIN_ROUTES)(
      'returns 401 with the wrong bearer token for $method $url',
      async ({ method, url }) => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: 'Bearer wrong-token' },
        });
        expect(res.statusCode).toBe(401);
      },
    );

    it.each(STATUS_ROUTES)(
      'returns 200 with the correct bearer token for $method $url',
      async ({ method, url }) => {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as { data: unknown };
        expect(body).toHaveProperty('data');
      },
    );

    it('POST /ingest returns 503 when DISCOGS_TOKEN/USERNAME are unset', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/ingest',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload)).toEqual({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Discogs credentials not configured' },
      });
    });

    it('POST /master-data/enrich returns 503 when DISCOGS_TOKEN is unset', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/master-data/enrich',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(503);
    });

    it('POST /nationality/enrich returns 503 when MUSICBRAINZ_USER_AGENT is unset', async () => {
      // beforeEach already cleared MUSICBRAINZ_USER_AGENT to the baseline.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/nationality/enrich',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(503);
    });
  });
});
