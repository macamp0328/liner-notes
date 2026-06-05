import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Driver } from 'neo4j-driver';
import { buildTestServer, initTestDriver } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getJobState, resetJobState, type JobState } from '../../../src/ingestion/job-state.js';
import release7000001 from '../../fixtures/releases/release-7000001.json' with { type: 'json' };
import { snapshotEnv, type EnvSnapshot } from '../../helpers/env.js';

const RELEASE_ID = 7000001;

// Env vars the auto-ingest onReady branch reads. Saved and restored around the
// suite so a leaked DISCOGS_* value never bleeds into another integration file.
const ENV_KEYS = [
  'DISCOGS_TOKEN',
  'DISCOGS_USERNAME',
  'DISCOGS_USER_AGENT',
  'DISCOGS_REQUEST_DELAY_MS',
] as const;

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function make404(): Response {
  return makeJsonResponse(404, { message: 'Not Found' });
}

function buildCollectionPage(ids: number[]): unknown {
  return {
    pagination: { page: 1, pages: 1, per_page: 50, items: ids.length, urls: {} },
    releases: ids.map((id) => ({ id, basic_information: { id, title: `release ${id}` } })),
  };
}

// Same URL router as tests/integration/ingestion/pipeline.test.ts: serve the
// collection + the seed release fixture, and 404 for every other URL (LRCLIB,
// Genius, masters, artist profiles, ...). Each downstream enrichment handles 404
// gracefully, so the pipeline completes without making any real network call.
function defaultRouter(url: string): Response {
  if (url.includes('/collection/folders/0/releases')) {
    return makeJsonResponse(200, buildCollectionPage([RELEASE_ID]));
  }
  if (url.includes(`/releases/${RELEASE_ID}`)) {
    return makeJsonResponse(200, release7000001);
  }
  return make404();
}

// Poll the in-memory job state set by server.ts onReady (startJob → completeJob).
async function waitForJobToFinish(timeoutMs = 15_000): Promise<JobState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = getJobState();
    if (state.status === 'complete' || state.status === 'failed') return state;
    if (Date.now() > deadline) {
      throw new Error(`auto-ingest job did not finish in ${timeoutMs}ms (status: ${state.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('auto-ingest on empty graph (server onReady)', () => {
  let app: FastifyInstance | undefined;
  let driver: Driver | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let envSnapshot: EnvSnapshot;

  beforeAll(() => {
    envSnapshot = snapshotEnv(ENV_KEYS);
    process.env['DISCOGS_TOKEN'] = 'test-token';
    process.env['DISCOGS_USERNAME'] = 'integration-test-user';
    process.env['DISCOGS_USER_AGENT'] = 'liner-notes/test';
    // buildDiscogsClientFromEnv clamps anything < 100ms back up to the 1000ms
    // default, so 100 (the enforced floor) is the fastest legal value. Only the two
    // successful Discogs requests (collection page + release) sleep ~100ms each;
    // every 404 throws without sleeping, so the whole run stays well under a second.
    process.env['DISCOGS_REQUEST_DELAY_MS'] = '100';
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  afterAll(async () => {
    envSnapshot.restore();
    resetJobState();
    // The driver and app are created mid-test, so an early failure can leave
    // either unset — guard cleanup so it never throws over the original error.
    if (driver) await clearGraph(driver);
    if (app) await app.close();
  });

  it('auto-triggers ingestion when the graph is empty and persists the release', async () => {
    // 1. Empty graph BEFORE onReady so hasReleases() returns false. The driver
    //    initialised here is the same singleton the server reuses in onReady.
    driver = initTestDriver();
    await clearGraph(driver);

    // 2. Stub fetch BEFORE app.ready() — onReady fires runIngestion fire-and-forget,
    //    so the spy must already be in place when buildTestServer readies the app.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: unknown) => Promise.resolve(defaultRouter(String(input))));

    // 3. Build with autoIngest enabled; buildTestServer calls app.ready() internally.
    app = await buildTestServer({ autoIngest: true });

    // 4. Wait for the onReady success branch to call completeJob().
    const state = await waitForJobToFinish();
    expect(state.status).toBe('complete');
    expect(fetchSpy).toHaveBeenCalled();

    // 5. The release landed — assert via the public REST API, proving the whole
    //    onReady → DiscogsClient → Neo4j → API stack agrees it was written.
    const res = await app.inject({ method: 'GET', url: `/api/v1/releases/${RELEASE_ID}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as {
      data: { title: string; tracks: { position: string }[] };
    };
    expect(body.data.title).toBe('Maiden Voyage');
    expect(body.data.tracks.length).toBeGreaterThan(0);
  });
});
