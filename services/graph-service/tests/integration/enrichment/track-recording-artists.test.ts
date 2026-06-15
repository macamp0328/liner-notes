import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { enrichTrackRecordingArtists } from '../../../src/enrichment/track-recording-artists.js';
import { resetRecordingArtistsEnrichment } from '../../../src/db/track-recording-artists-repository.js';
import type {
  MbRecordingArtist,
  MusicBrainzClient,
} from '../../../src/ingestion/musicbrainz-client.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A mock MB client returning canned recording artist-rels keyed by recordingMbid. */
function makeMbClient(byRecording: Record<string, MbRecordingArtist[]>): MusicBrainzClient {
  return {
    getArtistsByRecordingMbid: async (mbid: string) => byRecording[mbid] ?? [],
  } as unknown as MusicBrainzClient;
}

/**
 * Seed three recordings: one whose performer is already an in-collection Musician (resolved by the
 * `mb-artist-id` musicbrainzId, no duplicate expected); one whose performer exists only as an Artist
 * (an MBID-keyed fallback Musician + SAME_PERSON_AS expected); one with no performance relations.
 */
async function seed(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(
      `CREATE (:Musician {discogsId: 5001, musicbrainzId: 'mb-resolved', name: 'Resolved Person'})
       CREATE (:Artist {discogsId: 7001, musicbrainzId: 'mb-artistonly', name: 'Artist Only'})
       CREATE (:Track {position: 'A1', releaseDiscogsId: 9001, title: 'Resolved', recordingMbid: 'rec-resolved'})
       CREATE (:Track {position: 'B1', releaseDiscogsId: 9001, title: 'ArtistOnly', recordingMbid: 'rec-artistonly'})
       CREATE (:Track {position: 'C1', releaseDiscogsId: 9001, title: 'None', recordingMbid: 'rec-none'})`,
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

const client = makeMbClient({
  'rec-resolved': [
    {
      mbid: 'mb-resolved',
      name: 'Resolved Person',
      role: 'instrument',
      attributes: ['bass guitar'],
    },
  ],
  'rec-artistonly': [
    { mbid: 'mb-artistonly', name: 'Artist Only', role: 'vocal', attributes: ['lead vocals'] },
  ],
  'rec-none': [],
});

describe('track-recording-artists enrichment (#335, real Neo4j)', () => {
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

  it('writes a track-scoped MB credit to the resolved Musician without creating a duplicate', async () => {
    const summary = await enrichTrackRecordingArtists(client, getDriver(), silentLogger);
    expect(summary.recordingsFailed).toBe(0);

    // The credit lands on the EXISTING discogsId-keyed Musician (matched by musicbrainzId).
    const edge = await scalar(
      `MATCH (:Musician {discogsId: 5001})-[c:CREDITED_ON {scope: 'track', source: 'musicbrainz'}]->
             (:Track {recordingMbid: 'rec-resolved'})
       WHERE c.recordingMbid = 'rec-resolved' AND c.role = 'bass guitar'
       RETURN count(c) AS c`,
    );
    expect(edge).toBe(1);

    // No duplicate person node for that MBID.
    expect(
      await scalar(`MATCH (m:Musician {musicbrainzId: 'mb-resolved'}) RETURN count(m) AS c`),
    ).toBe(1);
  });

  it('creates an MBID-keyed fallback Musician linked to the same-MBID Artist via SAME_PERSON_AS', async () => {
    await enrichTrackRecordingArtists(client, getDriver(), silentLogger);

    // Fallback Musician: musicbrainzId set, no discogsId, carries the credit.
    const fallbackCredit = await scalar(
      `MATCH (m:Musician {musicbrainzId: 'mb-artistonly'})
             -[c:CREDITED_ON {scope: 'track', source: 'musicbrainz'}]->
             (:Track {recordingMbid: 'rec-artistonly'})
       WHERE m.discogsId IS NULL AND m.name = 'Artist Only' AND c.role = 'lead vocals'
       RETURN count(c) AS c`,
    );
    expect(fallbackCredit).toBe(1);

    // Linked to the Artist counterpart by the MBID join.
    const link = await scalar(
      `MATCH (:Musician {musicbrainzId: 'mb-artistonly'})-[:SAME_PERSON_AS]->(:Artist {discogsId: 7001})
       RETURN count(*) AS c`,
    );
    expect(link).toBe(1);
  });

  it('stamps a recording with no performance relations and writes no credit (no-op)', async () => {
    const summary = await enrichTrackRecordingArtists(client, getDriver(), silentLogger);

    expect(summary.recordingsProcessed).toBe(2);
    expect(summary.recordingsSkipped).toBe(1);
    expect(
      await scalar(
        `MATCH (:Track {recordingMbid: 'rec-none'})<-[c:CREDITED_ON {source: 'musicbrainz'}]-() RETURN count(c) AS c`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        `MATCH (t:Track {recordingMbid: 'rec-none'}) WHERE t.recordingArtistsFetchedAt IS NOT NULL RETURN count(t) AS c`,
      ),
    ).toBe(1);
  });

  it('is idempotent — a second run adds no duplicate edges or nodes', async () => {
    await enrichTrackRecordingArtists(client, getDriver(), silentLogger);
    await enrichTrackRecordingArtists(client, getDriver(), silentLogger);

    expect(
      await scalar(`MATCH ()-[c:CREDITED_ON {source: 'musicbrainz'}]->() RETURN count(c) AS c`),
    ).toBe(2);
    expect(
      await scalar(`MATCH (m:Musician {musicbrainzId: 'mb-artistonly'}) RETURN count(m) AS c`),
    ).toBe(1);
  });

  it('does not clobber an existing Discogs credit for the same person/track', async () => {
    // Pre-seed a Discogs track credit from the resolved person on the same track.
    const session = getDriver().session();
    try {
      await session.run(
        `MATCH (m:Musician {discogsId: 5001}), (t:Track {recordingMbid: 'rec-resolved'})
         MERGE (m)-[:CREDITED_ON {scope: 'track', role: 'Drums', displayRole: 'Drums', roleCategory: 'performer'}]->(t)`,
      );
    } finally {
      await session.close();
    }

    await enrichTrackRecordingArtists(client, getDriver(), silentLogger);

    // The original Discogs edge survives unchanged (still 'Drums', no musicbrainz source on it).
    const discogsEdge = await scalar(
      `MATCH (:Musician {discogsId: 5001})-[c:CREDITED_ON]->(:Track {recordingMbid: 'rec-resolved'})
       WHERE c.role = 'Drums' AND c.source IS NULL
       RETURN count(c) AS c`,
    );
    expect(discogsEdge).toBe(1);
  });

  it('reset removes MB credits and fallback Musicians but keeps the resolved person', async () => {
    await enrichTrackRecordingArtists(client, getDriver(), silentLogger);

    const reset = await resetRecordingArtistsEnrichment(getDriver());
    expect(reset).toBeGreaterThan(0);

    expect(
      await scalar(`MATCH ()-[c:CREDITED_ON {source: 'musicbrainz'}]->() RETURN count(c) AS c`),
    ).toBe(0);
    // Fallback (discogsId-null) gone; resolved (discogsId 5001) kept.
    expect(
      await scalar(`MATCH (m:Musician {musicbrainzId: 'mb-artistonly'}) RETURN count(m) AS c`),
    ).toBe(0);
    expect(await scalar(`MATCH (m:Musician {discogsId: 5001}) RETURN count(m) AS c`)).toBe(1);
    expect(
      await scalar(
        `MATCH (t:Track) WHERE t.recordingArtistsFetchedAt IS NOT NULL RETURN count(t) AS c`,
      ),
    ).toBe(0);
  });
});
