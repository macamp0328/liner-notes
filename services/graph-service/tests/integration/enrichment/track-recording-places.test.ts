import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { enrichTrackRecordingPlaces } from '../../../src/enrichment/track-recording-places.js';
import { resetRecordingPlacesEnrichment } from '../../../src/db/track-recording-places-repository.js';
import { getReleasesByStudio } from '../../../src/db/repositories/explore-repository.js';
import type {
  MbRecordingPlace,
  MusicBrainzClient,
} from '../../../src/ingestion/musicbrainz-client.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A mock MB client returning canned recording place-rels keyed by recordingMbid. */
function makeMbClient(byRecording: Record<string, MbRecordingPlace[]>): MusicBrainzClient {
  return {
    getPlacesByRecordingMbid: async (mbid: string) => byRecording[mbid] ?? [],
  } as unknown as MusicBrainzClient;
}

const ABBEY_ROAD: MbRecordingPlace = {
  placeMbid: 'place-abbey',
  name: 'Abbey Road Studios',
  relation: 'recorded at',
  latitude: 51.53192,
  longitude: -0.17835,
  area: "St John's Wood",
};

/**
 * Seed a Release with two Tracks (one carrying a studio recording, one whose recording has no
 * place-rels) plus a separate Release whose Discogs studio shares the MusicBrainz name, to prove the
 * name-key join.
 */
async function seed(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(
      `CREATE (r:Release {discogsId: 9001, title: 'Abbey Album'})
       CREATE (t1:Track {position: 'A1', releaseDiscogsId: 9001, title: 'Studio Track', recordingMbid: 'rec-abbey'})
       CREATE (t2:Track {position: 'B1', releaseDiscogsId: 9001, title: 'No Studio', recordingMbid: 'rec-none'})
       CREATE (r)-[:HAS_TRACK]->(t1)
       CREATE (r)-[:HAS_TRACK]->(t2)
       // A pre-existing Discogs-keyed Studio of the same name (album-level), no coordinates yet. It
       // carries the canonical nameKey the Discogs writer sets (#443), so the enrichment's
       // nameKey-keyed MERGE lines up onto this node instead of creating a second one.
       CREATE (disc:Release {discogsId: 9002, title: 'Discogs Album'})
       CREATE (s:Studio {name: 'Abbey Road Studios', nameKey: 'abbey road studios'})
       CREATE (disc)-[:RECORDED_AT]->(s)`,
    );
  } finally {
    await session.close();
  }
}

async function scalar(cypher: string): Promise<number> {
  const session = getDriver().session();
  try {
    const res = await session.run(cypher);
    return (res.records[0]?.get('c') as { toNumber(): number } | undefined)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}

const client = makeMbClient({ 'rec-abbey': [ABBEY_ROAD], 'rec-none': [] });

describe('track-recording-places enrichment (#339 slice 2, real Neo4j)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  beforeEach(async () => {
    await clearGraph(getDriver());
    await seed();
  });

  it('writes a track-scoped RECORDED_AT to the name-matched Studio and fills its coordinates', async () => {
    const summary = await enrichTrackRecordingPlaces(client, getDriver(), silentLogger);
    expect(summary.recordingsFailed).toBe(0);

    // The track-level edge carries source/relation/recordingMbid provenance.
    const edge = await scalar(
      `MATCH (:Track {recordingMbid: 'rec-abbey'})
             -[ra:RECORDED_AT {source: 'musicbrainz', relation: 'recorded at'}]->
             (:Studio {name: 'Abbey Road Studios'})
       WHERE ra.recordingMbid = 'rec-abbey'
       RETURN count(ra) AS c`,
    );
    expect(edge).toBe(1);

    // Coordinates landed on the EXISTING (Discogs-created) Studio node — name is the join key, so
    // there is still exactly one node and it now carries location data.
    expect(await scalar(`MATCH (s:Studio {name: 'Abbey Road Studios'}) RETURN count(s) AS c`)).toBe(
      1,
    );
    const located = await scalar(
      `MATCH (s:Studio {name: 'Abbey Road Studios'})
       WHERE s.latitude = 51.53192 AND s.longitude = -0.17835 AND s.area = "St John's Wood"
         AND s.musicbrainzPlaceId = 'place-abbey'
       RETURN count(s) AS c`,
    );
    expect(located).toBe(1);
  });

  it('stamps a recording with no place relations and writes no studio edge (no-op skip)', async () => {
    const summary = await enrichTrackRecordingPlaces(client, getDriver(), silentLogger);

    expect(summary.recordingsProcessed).toBe(1);
    expect(summary.recordingsSkipped).toBe(1);
    expect(
      await scalar(
        `MATCH (:Track {recordingMbid: 'rec-none'})-[ra:RECORDED_AT]->(:Studio) RETURN count(ra) AS c`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        `MATCH (t:Track {recordingMbid: 'rec-none'}) WHERE t.recordingPlacesFetchedAt IS NOT NULL RETURN count(t) AS c`,
      ),
    ).toBe(1);
  });

  it('is idempotent — a second run adds no duplicate edges', async () => {
    await enrichTrackRecordingPlaces(client, getDriver(), silentLogger);
    await enrichTrackRecordingPlaces(client, getDriver(), silentLogger);

    expect(
      await scalar(`MATCH ()-[ra:RECORDED_AT {source: 'musicbrainz'}]->() RETURN count(ra) AS c`),
    ).toBe(1);
  });

  it('surfaces the track-level studio via /explore/studio (rolled up to the Release)', async () => {
    await enrichTrackRecordingPlaces(client, getDriver(), silentLogger);

    // The studio query now returns BOTH the album-level Discogs release (9002) and the track-level
    // release (9001), deduped, via the HAS_TRACK rollup.
    const releases = await getReleasesByStudio(getDriver(), 'Abbey Road Studios');
    const ids = releases.map((r) => r.discogsId);
    expect(ids).toContain(9001);
    expect(ids).toContain(9002);
    // No duplicate rows for a release credited at one level.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reset removes MB studio edges and the marker but keeps the Studio node and its coordinates', async () => {
    await enrichTrackRecordingPlaces(client, getDriver(), silentLogger);

    const reset = await resetRecordingPlacesEnrichment(getDriver());
    expect(reset).toBeGreaterThan(0);

    // MB-sourced track→studio edges gone; the album-level Discogs edge survives.
    expect(
      await scalar(`MATCH ()-[ra:RECORDED_AT {source: 'musicbrainz'}]->() RETURN count(ra) AS c`),
    ).toBe(0);
    expect(
      await scalar(
        `MATCH (:Release {discogsId: 9002})-[ra:RECORDED_AT]->(:Studio) RETURN count(ra) AS c`,
      ),
    ).toBe(1);
    // Studio node and its enriched coordinates persist (a physical fact, feeds the map / #342).
    expect(
      await scalar(
        `MATCH (s:Studio {name: 'Abbey Road Studios'}) WHERE s.latitude = 51.53192 RETURN count(s) AS c`,
      ),
    ).toBe(1);
    // The marker is cleared so a re-run reproduces the edges from scratch.
    expect(
      await scalar(
        `MATCH (t:Track) WHERE t.recordingPlacesFetchedAt IS NOT NULL RETURN count(t) AS c`,
      ),
    ).toBe(0);
  });
});
