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
      // Artist-genres/styles + a nationality edge tagged with its resolving source.
      // The genres/styles coverage numerator is path-gated (it only counts an artist
      // that also has a release→genre/style edge), so wire those edges onto one of the
      // artist's releases to land it in both numerator and denominator.
      await session.run(
        `MATCH (a:Artist) WHERE a.profile = 'A short bio.'
         MATCH (a)<-[:RELEASED_BY]-(r:Release)
         WITH a, r LIMIT 1
         MERGE (g:Genre {name: 'Jazz'})
         MERGE (r)-[:IN_GENRE]->(g)
         MERGE (s:Style {name: 'Hard Bop'})
         MERGE (r)-[:IN_STYLE]->(s)
         SET a.genres = ['Jazz'], a.styles = ['Hard Bop']
         MERGE (c:Country {name: 'US'})
         MERGE (a)-[rel:ORIGIN_COUNTRY]->(c)
         SET rel.source = 'musicbrainz'`,
      );
      // One resolved track (deliberately left with no lyricsStatus to exercise the
      // legacy-null-status path: the funnel counts it resolved via lyrics IS NOT NULL).
      await session.run(
        `MATCH (t:Track) WITH t LIMIT 1
         SET t.lyrics = 'la la la', t.lyricsSource = 'lrclib',
             t.recordingMbid = 'mbid-1', t.isrc = 'ISRC0001',
             t.tempo = 120.0, t.deezerBpm = 121.0, t.deezerGain = -7.5`,
      );
      // Two instrumental classes + one not-found, so the funnel exercises every bucket
      // and the non-instrumental denominator differs from the total track count (#246).
      await session.run(
        `MATCH (t:Track) WHERE t.lyrics IS NULL WITH t LIMIT 1
         SET t.lyricsStatus = 'instrumental'`,
      );
      await session.run(
        `MATCH (t:Track) WHERE t.lyrics IS NULL AND t.lyricsStatus IS NULL WITH t LIMIT 1
         SET t.lyricsStatus = 'probable-instrumental'`,
      );
      await session.run(
        `MATCH (t:Track) WHERE t.lyrics IS NULL AND t.lyricsStatus IS NULL WITH t LIMIT 1
         SET t.lyricsStatus = 'not-found'`,
      );
      await session.run(`MERGE (m:Master {discogsId: 555555})`);
      // mb-release-events output on the master.
      await session.run(
        `MATCH (m:Master {discogsId: 555555})
         MERGE (c:Country {name: 'US'})
         MERGE (m)-[r:MB_RELEASED_IN {mbReleaseId: 'mb-rel-1'}]->(c)
         SET r.date = '1959', r.formats = ['Vinyl']`,
      );
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
    expect(enrichment.tracksWithDeezerGain).toEqual({ covered: 1, applicable: 1, pct: 100 });

    // New per-stage coverage figures. Genres/styles covered is path-gated, so it can
    // never exceed applicable (the numerator and denominator share the same path gate).
    expect(enrichment.artistsWithGenres.covered).toBeGreaterThanOrEqual(1);
    expect(enrichment.artistsWithGenres.covered).toBeLessThanOrEqual(
      enrichment.artistsWithGenres.applicable,
    );
    expect(enrichment.artistsWithStyles.covered).toBeGreaterThanOrEqual(1);
    expect(enrichment.artistsWithStyles.covered).toBeLessThanOrEqual(
      enrichment.artistsWithStyles.applicable,
    );
    expect(enrichment.mastersWithReleaseEvents).toEqual({ covered: 1, applicable: 1, pct: 100 });

    // The lyrics track came from LRCLIB; the per-source split reflects it.
    expect(enrichment.tracksWithLyrics.sources.lrclib!.covered).toBe(1);
    expect(enrichment.tracksWithLyrics.sources.genius!.covered).toBe(0);

    // The one nationality edge is tagged musicbrainz; the split attributes it there.
    expect(enrichment.artistsWithNationality.covered).toBeGreaterThanOrEqual(1);
    expect(enrichment.artistsWithNationality.sources.musicbrainz!.covered).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('reports the four-state lyrics funnel with a non-instrumental denominator (#246)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    const { enrichment, counts } = (JSON.parse(res.payload) as StatsBody).data;
    const f = enrichment.lyricsFunnel;

    // Exactly the classes we seeded; resolved counts the legacy null-status track.
    expect(f.total).toBe(counts.tracks);
    expect(f.resolved).toBe(1);
    expect(f.instrumental).toBe(1);
    expect(f.probableInstrumental).toBe(1);
    // The four buckets partition total exactly.
    expect(f.resolved + f.instrumental + f.probableInstrumental + f.notFound).toBe(f.total);

    // The honest denominator excludes both instrumental classes (2), so it is smaller
    // than the total track count while still containing the one resolved track.
    expect(enrichment.tracksWithLyrics.covered).toBe(1);
    expect(enrichment.tracksWithLyrics.applicable).toBe(counts.tracks - 2);
  });

  it('exposes the endpoint without an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/stats' });
    // No Authorization header sent — a public endpoint must still return 200.
    expect(res.statusCode).toBe(200);
  });
});
