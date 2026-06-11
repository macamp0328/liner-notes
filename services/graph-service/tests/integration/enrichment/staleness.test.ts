import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { getTracksForDeezerEnrichment } from '../../../src/db/track-deezer-repository.js';
import { getTracksForAcousticBrainzEnrichment } from '../../../src/db/track-acousticbrainz-repository.js';
import { getUnenrichedArtistsForNationality } from '../../../src/db/artist-nationality-repository.js';
import { getUnenrichedTracks } from '../../../src/db/lyrics-repository.js';

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

  it('lyrics gate (#246): excludes instrumental/probable-instrumental, keeps stale not-found', async () => {
    // The lyrics candidate query joins through Release-[:HAS_TRACK]->Track, so each
    // fixture track hangs off one Release. lyricsStatus drives the terminal exclusion;
    // not-found stays re-eligible per the staleness window.
    await write(`
      CREATE (r:Release {discogsId: 1})
      CREATE (never:Track     {title: 'never',     position: 'A1', releaseDiscogsId: 1})
      CREATE (instr:Track     {title: 'instr',     position: 'A2', releaseDiscogsId: 1,
                               lyricsStatus: 'instrumental',
                               lyricsFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (probable:Track  {title: 'probable',  position: 'A3', releaseDiscogsId: 1,
                               lyricsStatus: 'probable-instrumental',
                               lyricsFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (staleNF:Track   {title: 'staleNF',   position: 'A4', releaseDiscogsId: 1,
                               lyricsStatus: 'not-found',
                               lyricsFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (freshNF:Track   {title: 'freshNF',   position: 'A5', releaseDiscogsId: 1,
                               lyricsStatus: 'not-found', lyricsFetchedAt: datetime()})
      CREATE (resolved:Track  {title: 'resolved',  position: 'A6', releaseDiscogsId: 1,
                               lyrics: 'la la', lyricsStatus: 'resolved',
                               lyricsFetchedAt: datetime() - duration({ days: 60 })})
      CREATE (r)-[:HAS_TRACK]->(never)
      CREATE (r)-[:HAS_TRACK]->(instr)
      CREATE (r)-[:HAS_TRACK]->(probable)
      CREATE (r)-[:HAS_TRACK]->(staleNF)
      CREATE (r)-[:HAS_TRACK]->(freshNF)
      CREATE (r)-[:HAS_TRACK]->(resolved)
    `);

    const titles = (await getUnenrichedTracks(getDriver())).map((t) => t.title).sort();

    // never-attempted + stale not-found → selected; the two instrumental classes are
    // terminal, fresh not-found is within the window, resolved has lyrics → all excluded.
    expect(titles).toEqual(['never', 'staleNF']);
  });
});
