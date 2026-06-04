import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { getTracksForDeezerEnrichment } from '../../../src/db/track-deezer-repository.js';
import { getTracksForAcousticBrainzEnrichment } from '../../../src/db/track-acousticbrainz-repository.js';
import { getUnenrichedArtistsForNationality } from '../../../src/db/artist-nationality-repository.js';

/**
 * Exercises the issue #89 re-enrichment gate against a real Neo4j, proving the
 * `datetime() - duration({ days })` round-trip that mocked-session unit tests cannot.
 * Covers both gate shapes: a property-null gate (Deezer: deezerBpm/deezerGain IS NULL)
 * and a relationship-absence gate (nationality: NOT EXISTS ORIGIN_COUNTRY). Each fixture
 * spans the four cases the gate must distinguish:
 *   (a) data present  + old timestamp  → skipped (already enriched, never re-fetched)
 *   (b) data missing  + fresh timestamp → skipped (attempt is still within the window)
 *   (c) data missing  + null timestamp → selected (never attempted)
 *   (d) data missing  + old timestamp  → selected (attempt aged past the window)
 */
async function write(cypher: string): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(cypher);
  } finally {
    await session.close();
  }
}

describe('re-enrichment staleness gate (issue #89)', () => {
  let app: FastifyInstance;
  let originalStaleness: string | undefined;

  beforeAll(async () => {
    app = await buildTestServer();
    // Pin the default 30-day window regardless of ambient env.
    originalStaleness = process.env['ENRICHMENT_STALENESS_DAYS'];
    delete process.env['ENRICHMENT_STALENESS_DAYS'];
  });

  afterAll(async () => {
    if (originalStaleness === undefined) delete process.env['ENRICHMENT_STALENESS_DAYS'];
    else process.env['ENRICHMENT_STALENESS_DAYS'] = originalStaleness;
    await clearGraph(getDriver());
    await app.close();
  });

  beforeEach(async () => {
    await clearGraph(getDriver());
  });

  it('property-null gate (Deezer): retries only still-missing tracks past the window', async () => {
    await write(`
      CREATE (:Track {isrc: 'NULL-TS',    position: 'A1', releaseDiscogsId: 1})
      CREATE (:Track {isrc: 'OLD-TS',     position: 'A2', releaseDiscogsId: 1,
                      deezerFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (:Track {isrc: 'FRESH-TS',   position: 'A3', releaseDiscogsId: 1,
                      deezerFetchedAt: datetime()})
      CREATE (:Track {isrc: 'HAS-DATA',   position: 'A4', releaseDiscogsId: 1,
                      deezerBpm: 120.0, deezerFetchedAt: datetime() - duration({ days: 60 })})
    `);

    const tracks = await getTracksForDeezerEnrichment(getDriver());
    const isrcs = tracks.map((t) => t.isrc).sort();

    // null timestamp (never attempted) + old timestamp (stale) → selected;
    // fresh timestamp + already-populated → skipped.
    expect(isrcs).toEqual(['NULL-TS', 'OLD-TS']);
  });

  it('relationship-absence gate (nationality): retries only un-countried nodes past the window', async () => {
    await write(`
      CREATE (:Artist {discogsId: 9001, name: 'Null TS'})
      CREATE (:Artist {discogsId: 9002, name: 'Old TS',
                       nationalityFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (:Artist {discogsId: 9003, name: 'Fresh TS',
                       nationalityFetchedAt: datetime()})
      CREATE (a:Artist {discogsId: 9004, name: 'Has Country',
                        nationalityFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (c:Country {name: 'US'})
      CREATE (a)-[:ORIGIN_COUNTRY]->(c)
    `);

    const artists = await getUnenrichedArtistsForNationality(getDriver());
    const ids = artists.map((a) => a.discogsId).sort((x, y) => x - y);

    // 9001 (never attempted) + 9002 (stale) → selected;
    // 9003 (fresh) + 9004 (already countried) → skipped.
    expect(ids).toEqual([9001, 9002]);
  });

  it('property-null gate (AcousticBrainz): a partial-feature track is not re-selected', async () => {
    // The low/high-level docs are independent and bpm:0 coerces to null, so a track can
    // carry a key/scale with a null tempo. The gate must treat "any feature present" as
    // enriched — using coalesce over all seven features, not tempo alone.
    await write(`
      CREATE (:Track {recordingMbid: 'mbid-null',  position: 'A1', releaseDiscogsId: 1})
      CREATE (:Track {recordingMbid: 'mbid-old',   position: 'A2', releaseDiscogsId: 1,
                      acousticBrainzFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (:Track {recordingMbid: 'mbid-fresh', position: 'A3', releaseDiscogsId: 1,
                      acousticBrainzFetchedAt: datetime()})
      CREATE (:Track {recordingMbid: 'mbid-partial', position: 'A4', releaseDiscogsId: 1,
                      musicalKey: 'C', musicalScale: 'major',
                      acousticBrainzFetchedAt: datetime() - duration({ days: 60 })})
    `);

    const tracks = await getTracksForAcousticBrainzEnrichment(getDriver());
    const mbids = tracks.map((t) => t.recordingMbid).sort();

    // null timestamp + stale-with-no-features → selected; fresh → skipped;
    // 'mbid-partial' has key/scale (tempo null) → already enriched → NOT re-selected.
    expect(mbids).toEqual(['mbid-null', 'mbid-old']);
  });
});
