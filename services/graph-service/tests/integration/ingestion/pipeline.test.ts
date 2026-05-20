import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { DiscogsClient } from '../../../src/ingestion/discogs-client.js';
import { runIngestion } from '../../../src/ingestion/ingest.js';
import release7000001 from '../../fixtures/releases/release-7000001.json' with { type: 'json' };

const TEST_USERNAME = 'integration-test-user';
const RELEASE_ID = 7000001;
const MISSING_RELEASE_ID = 9999999;

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

function make429(retryAfterSecs = 0): Response {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: { get: (name: string) => (name === 'Retry-After' ? String(retryAfterSecs) : null) },
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

function buildCollectionPage(ids: number[]): unknown {
  return {
    pagination: { page: 1, pages: 1, per_page: 50, items: ids.length, urls: {} },
    releases: ids.map((id) => ({ id, basic_information: { id, title: `release ${id}` } })),
  };
}

function buildClient(): DiscogsClient {
  return new DiscogsClient({
    token: 'test-token',
    userAgent: 'liner-notes/test',
    delayMs: 0,
    backoffBaseMs: 0,
  });
}

// Counts every node in the graph so idempotency assertions don't depend on
// the schema staying static across enrichment passes.
async function countAllNodes(): Promise<number> {
  const session = getDriver().session();
  try {
    const result = await session.run('MATCH (n) RETURN count(n) AS n');
    return (result.records[0]?.get('n') as { toNumber: () => number }).toNumber();
  } finally {
    await session.close();
  }
}

describe('ingestion pipeline (mocked Discogs)', () => {
  let app: FastifyInstance;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  beforeEach(async () => {
    await clearGraph(getDriver());
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // Default URL router: serves the collection + the seed release fixture, and
  // returns 404 for every other URL (LRCLIB, Genius, masters, artist profiles,
  // etc.). Each downstream enrichment handles 404 gracefully, so the pipeline
  // completes without making any real network call.
  function defaultRouter(url: string): Response {
    if (url.includes('/collection/folders/0/releases')) {
      return makeJsonResponse(200, buildCollectionPage([RELEASE_ID]));
    }
    if (url.includes(`/releases/${RELEASE_ID}`)) {
      return makeJsonResponse(200, release7000001);
    }
    return make404();
  }

  it('happy path: ingests a single release and persists all expected nodes', async () => {
    fetchSpy.mockImplementation((input: unknown) => Promise.resolve(defaultRouter(String(input))));

    const summary = await runIngestion(buildClient(), getDriver(), { username: TEST_USERNAME });

    expect(summary.releasesProcessed).toBe(1);
    expect(summary.releasesFailed).toBe(0);

    // Verify via the public API rather than reaching into Cypher directly —
    // this proves the end-to-end stack agrees the release was written.
    const res = await app.inject({ method: 'GET', url: `/api/v1/releases/${RELEASE_ID}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as {
      data: {
        title: string;
        tracks: { position: string }[];
        credits: { name: string }[];
        labels: { name: string }[];
        studios: string[];
      };
    };
    expect(body.data.title).toBe('Maiden Voyage');
    expect(body.data.tracks.map((t) => t.position)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(body.data.credits.some((c) => c.name === 'Ron Carter')).toBe(true);
    expect(body.data.labels.some((l) => l.name === 'Blue Note Records')).toBe(true);
    expect(body.data.studios).toContain('Van Gelder Studio');
  });

  it('idempotency: re-ingesting the same release does not grow the node count', async () => {
    fetchSpy.mockImplementation((input: unknown) => Promise.resolve(defaultRouter(String(input))));

    await runIngestion(buildClient(), getDriver(), { username: TEST_USERNAME });
    const firstCount = await countAllNodes();
    expect(firstCount).toBeGreaterThan(0);

    await runIngestion(buildClient(), getDriver(), { username: TEST_USERNAME });
    const secondCount = await countAllNodes();
    expect(secondCount).toBe(firstCount);
  });

  it('429 mid-ingest: retries and ultimately succeeds', async () => {
    // First /releases/{id} call returns 429, then the retry serves the fixture.
    let releaseHits = 0;
    fetchSpy.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/collection/folders/0/releases')) {
        return Promise.resolve(makeJsonResponse(200, buildCollectionPage([RELEASE_ID])));
      }
      if (url.includes(`/releases/${RELEASE_ID}`)) {
        releaseHits++;
        if (releaseHits === 1) return Promise.resolve(make429(0));
        return Promise.resolve(makeJsonResponse(200, release7000001));
      }
      return Promise.resolve(make404());
    });

    const summary = await runIngestion(buildClient(), getDriver(), { username: TEST_USERNAME });

    expect(releaseHits).toBeGreaterThanOrEqual(2);
    expect(summary.releasesProcessed).toBe(1);
    expect(summary.releasesFailed).toBe(0);
  });

  it('404 mid-ingest: skips the missing release and continues', async () => {
    fetchSpy.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/collection/folders/0/releases')) {
        return Promise.resolve(
          makeJsonResponse(200, buildCollectionPage([RELEASE_ID, MISSING_RELEASE_ID])),
        );
      }
      if (url.includes(`/releases/${RELEASE_ID}`)) {
        return Promise.resolve(makeJsonResponse(200, release7000001));
      }
      if (url.includes(`/releases/${MISSING_RELEASE_ID}`)) {
        return Promise.resolve(make404());
      }
      return Promise.resolve(make404());
    });

    const summary = await runIngestion(buildClient(), getDriver(), { username: TEST_USERNAME });

    expect(summary.releasesProcessed).toBe(1);
    expect(summary.releasesFailed).toBe(1);
    expect(summary.errors.some((e) => e.includes(String(MISSING_RELEASE_ID)))).toBe(true);

    // The good release still landed in the graph.
    const res = await app.inject({ method: 'GET', url: `/api/v1/releases/${RELEASE_ID}` });
    expect(res.statusCode).toBe(200);
  });
});
