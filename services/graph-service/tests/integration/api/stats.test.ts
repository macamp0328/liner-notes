import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { seedGraph, clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import type { StatsData } from '../../../src/db/stats-repository.js';

interface StatsBody {
  data: StatsData;
}

describe('GET /api/v1/stats', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
    await clearGraph(getDriver());
    await seedGraph(getDriver());

    // The seed loader runs base ingestion only (no enrichment), so coverage
    // would be all-zero. Enrich a deterministic slice directly so the covered
    // counts are exercised: one release (with a master), one artist, one track
    // carrying every track-level marker, plus one Master node.
    const session = getDriver().session();
    try {
      await session.run(
        `MATCH (r:Release) WITH r LIMIT 1
         SET r.masterDiscogsId = 555555, r.originalYear = 1959`,
      );
      await session.run(
        `MATCH (a:Artist) WHERE a.discogsId IS NOT NULL AND NOT a.discogsId IN [194, 355]
         WITH a LIMIT 1 SET a.profile = 'A short bio.'`,
      );
      await session.run(
        `MATCH (t:Track) WITH t LIMIT 1
         SET t.lyrics = 'la la la', t.lyricsSource = 'lrclib',
             t.recordingMbid = 'mbid-1', t.isrc = 'ISRC0001',
             t.tempo = 120.0, t.deezerBpm = 121.0`,
      );
      await session.run(`MERGE (m:Master {discogsId: 555555})`);
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  it('returns 200 with node counts reflecting the seeded graph', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.payload) as StatsBody;
    expect(body.data.counts.releases).toBeGreaterThanOrEqual(10);
    expect(body.data.counts.artists).toBeGreaterThan(0);
    expect(body.data.counts.tracks).toBeGreaterThan(0);
    expect(body.data.counts.masters).toBe(1);
  });

  it('reports enrichment coverage for the manually enriched slice', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    const { enrichment } = (JSON.parse(res.payload) as StatsBody).data;

    expect(enrichment.releasesWithOriginalYear.covered).toBe(1);
    expect(enrichment.releasesWithOriginalYear.applicable).toBeGreaterThanOrEqual(1);

    expect(enrichment.artistsWithProfile.covered).toBe(1);
    expect(enrichment.tracksWithLyrics.covered).toBe(1);
    expect(enrichment.tracksWithRecordingMbid.covered).toBe(1);
    expect(enrichment.tracksWithIsrc.covered).toBe(1);

    // tempo/deezer denominators are the upstream mbid/isrc gates (1 each here).
    expect(enrichment.tracksWithTempo).toEqual({ covered: 1, applicable: 1, pct: 100 });
    expect(enrichment.tracksWithDeezerBpm).toEqual({ covered: 1, applicable: 1, pct: 100 });
  });

  it('exposes the endpoint without an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    // No Authorization header sent — a public endpoint must still return 200.
    expect(res.statusCode).toBe(200);
  });
});
