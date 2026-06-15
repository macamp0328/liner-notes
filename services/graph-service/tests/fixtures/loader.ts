import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { mergeReleaseGraph } from '../../src/db/ingestion-repository.js';
import type { DiscogsRelease } from '../../src/ingestion/types.js';

const releasesDir = join(dirname(fileURLToPath(import.meta.url)), 'releases');

/** All seed releases, ordered deterministically by filename. */
function loadReleases(): DiscogsRelease[] {
  return (
    readdirSync(releasesDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      // Trusted, bounded read: `name` is a fixture filename listed from the fixed
      // in-repo `releasesDir`, never untrusted input — the pattern the rule targets.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      .map((name) => JSON.parse(readFileSync(join(releasesDir, name), 'utf8')) as DiscogsRelease)
  );
}

/**
 * Seed the graph by running the real ingestion transforms + MERGE writes
 * over every fixture in tests/fixtures/releases/. This exercises the same
 * code path as production ingestion — only the Discogs HTTP fetch is replaced
 * by static JSON.
 */
export async function seedGraph(driver: Driver): Promise<void> {
  for (const release of loadReleases()) {
    await mergeReleaseGraph(driver, release);
  }
}

/** Fully wipe the graph so each integration test file starts from empty. */
export async function clearGraph(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run('MATCH (n) DETACH DELETE n');
  } finally {
    await session.close();
  }
}

/**
 * Add the minimum enrichment data the three enrichment-dependent explore routes
 * need, so they exercise real ranking/filter logic instead of returning empty
 * arrays. Call this AFTER seedGraph(). It writes the same node/relationship/
 * property shapes the production enrichment pipelines write — only via direct
 * Cypher instead of network fetches — so the queries are tested faithfully:
 *
 *   - most-international: extra track-scope CREDITED_ON + ORIGIN_COUNTRY
 *     (see artist-nationality-repository.ts)
 *   - most-pressed:       a Master + RELEASED_IN (see master-data-repository.ts)
 *   - by-audio-features:  Track tempo/key/scale/etc. (see
 *     track-acousticbrainz-repository.ts) and deezerBpm/deezerGain (track-deezer)
 *
 * All entities are pinned to concrete seed nodes by stable keys (musician
 * discogsId, track position + releaseDiscogsId) so the data is deterministic and
 * does not perturb the other explore assertions, which all traverse
 * Release-relationship paths this helper never touches.
 */
export async function seedExploreEnrichment(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    // --- most-international ---------------------------------------------------
    // No fixture track carries >=2 track-scope musicians, so synthesize them:
    // credit three of the Maiden Voyage quartet (already release-scope credited)
    // on the title track A1 at TRACK scope, mirroring the ingestion CREDITED_ON
    // shape. Ron Carter (500001) already has this credit; MERGE re-sets it.
    await session.run(
      `UNWIND [
         {discogsId: 500001, role: 'Bass'},
         {discogsId: 500003, role: 'Trumpet'},
         {discogsId: 500004, role: 'Tenor Saxophone'}
       ] AS cr
       MATCH (m:Musician {discogsId: cr.discogsId})
       MATCH (t:Track {position: 'A1', releaseDiscogsId: 7000001})
       MERGE (m)-[co:CREDITED_ON]->(t)
       SET co.role = cr.role, co.displayRole = cr.role,
           co.roleCategory = 'performer', co.creditedAs = null, co.scope = 'track'`,
    );
    // Give those three musicians distinct origin countries. ORIGIN_COUNTRY stores
    // ISO 3166-1 alpha-2 codes (the nationality enrichment's output), so use
    // codes here. The specific countries are synthetic test values chosen to
    // exercise multi-country ranking — not the musicians' real nationalities.
    await session.run(
      `UNWIND [
         {discogsId: 500001, country: 'US'},
         {discogsId: 500003, country: 'FR'},
         {discogsId: 500004, country: 'JP'}
       ] AS n
       MATCH (m:Musician {discogsId: n.discogsId})
       MERGE (c:Country {name: n.country})
       MERGE (m)-[:ORIGIN_COUNTRY]->(c)
       SET m.nationalityFetched = true`,
    );

    // --- most-pressed --------------------------------------------------------
    // mergeReleaseGraph does not create Master nodes; create the Maiden Voyage
    // master (800001) released in three countries via RELEASED_IN (the rel the
    // route matches — not MB_RELEASED_IN). m.year is the master's original year
    // (1965, when the album first came out), deliberately distinct from the 1966
    // pressing carried by the release fixture. Unlike ORIGIN_COUNTRY above,
    // RELEASED_IN countries are Discogs version.country strings (e.g. 'US', 'UK',
    // 'Japan'), which are not ISO alpha-2 codes.
    await session.run(
      `MERGE (m:Master {discogsId: 800001})
       SET m.title = 'Maiden Voyage', m.year = 1965
       WITH m
       UNWIND ['US', 'UK', 'Japan'] AS country
       MERGE (c:Country {name: country})
       MERGE (m)-[rel:RELEASED_IN]->(c)
       SET rel.formats = ['Vinyl']`,
    );

    // --- by-audio-features ---------------------------------------------------
    // Attach distinct audio features to three Maiden Voyage tracks so tempo and
    // scale filters return predictable subsets. A1/A2 get AcousticBrainz data;
    // B1 gets Deezer-only data to exercise the dual-source tempo filter.
    await session.run(
      `MATCH (t:Track {position: 'A1', releaseDiscogsId: 7000001})
       SET t.acousticBrainzFetched = true,
           t.tempo = 90.0, t.musicalKey = 'C', t.musicalScale = 'major',
           t.loudnessDb = -8.0, t.dynamicComplexity = 3.0,
           t.danceabilityEstimate = 0.8, t.voiceInstrumental = 'voice'`,
    );
    await session.run(
      `MATCH (t:Track {position: 'A2', releaseDiscogsId: 7000001})
       SET t.acousticBrainzFetched = true,
           t.tempo = 140.0, t.musicalKey = 'A', t.musicalScale = 'minor',
           t.loudnessDb = -6.0, t.dynamicComplexity = 5.0,
           t.danceabilityEstimate = 0.4, t.voiceInstrumental = 'instrumental'`,
    );
    await session.run(
      `MATCH (t:Track {position: 'B1', releaseDiscogsId: 7000001})
       SET t.deezerFetched = true, t.deezerBpm = 120.0, t.deezerGain = -10.0`,
    );
  } finally {
    await session.close();
  }
}

/**
 * Seed Work (composition) fixtures (#336) for the track-works explore route. Call AFTER seedGraph().
 * Self-contained: creates its own Release/Track/Work nodes (discogsIds ≥ 7050000) so it neither
 * depends on nor perturbs the other explore assertions. Encodes the three acceptance cases:
 *
 *   - cover pair (work-cover-1):   two DISTINCT recordings on different releases → versions/covers.
 *   - same-recording duplicate (work-dup-1): ONE recording (same recordingMbid) on two releases →
 *     a duplicate, not a distinct version.
 *   - title collision (work-collide-a / -b): two recordings with the SAME track title but DIFFERENT
 *     Work MBIDs → must NOT be linked to each other.
 */
export async function seedWorks(driver: Driver): Promise<void> {
  const rows = [
    // cover pair → one Work, two distinct recordings
    {
      releaseDiscogsId: 7050001,
      releaseTitle: 'Cover Album A',
      pressingYear: 1990,
      position: 'A1',
      trackTitle: 'Shared Song',
      recordingMbid: 'rec-cover-a',
      workMbid: 'work-cover-1',
      workTitle: 'Shared Song',
    },
    {
      releaseDiscogsId: 7050002,
      releaseTitle: 'Cover Album B',
      pressingYear: 1995,
      position: 'A1',
      trackTitle: 'Shared Song (Live)',
      recordingMbid: 'rec-cover-b',
      workMbid: 'work-cover-1',
      workTitle: 'Shared Song',
    },
    // same-recording duplicate → one Work, one recording reissued on two releases
    {
      releaseDiscogsId: 7050003,
      releaseTitle: 'Original Album',
      pressingYear: 1980,
      position: 'A1',
      trackTitle: 'Dup Song',
      recordingMbid: 'rec-dup',
      workMbid: 'work-dup-1',
      workTitle: 'Dup Song',
    },
    {
      releaseDiscogsId: 7050004,
      releaseTitle: 'Greatest Hits',
      pressingYear: 1999,
      position: 'B2',
      trackTitle: 'Dup Song',
      recordingMbid: 'rec-dup',
      workMbid: 'work-dup-1',
      workTitle: 'Dup Song',
    },
    // title collision → two different Works sharing a track title
    {
      releaseDiscogsId: 7050005,
      releaseTitle: 'Diddley LP',
      pressingYear: 1956,
      position: 'A1',
      trackTitle: 'Who Do You Love',
      recordingMbid: 'rec-collide-a',
      workMbid: 'work-collide-a',
      workTitle: 'Who Do You Love?',
    },
    {
      releaseDiscogsId: 7050006,
      releaseTitle: 'Other LP',
      pressingYear: 1970,
      position: 'A1',
      trackTitle: 'Who Do You Love',
      recordingMbid: 'rec-collide-b',
      workMbid: 'work-collide-b',
      workTitle: 'Who Do You Love',
    },
  ];
  const session = driver.session();
  try {
    await session.run(
      `UNWIND $rows AS row
       MERGE (r:Release {discogsId: row.releaseDiscogsId})
         SET r.title = row.releaseTitle, r.pressingYear = row.pressingYear
       MERGE (t:Track {position: row.position, releaseDiscogsId: row.releaseDiscogsId})
         SET t.title = row.trackTitle, t.recordingMbid = row.recordingMbid
       MERGE (r)-[:HAS_TRACK]->(t)
       MERGE (w:Work {mbid: row.workMbid}) SET w.title = row.workTitle, w.type = 'Song'
       MERGE (t)-[rel:RECORDING_OF]->(w) SET rel.source = 'musicbrainz'`,
      { rows },
    );
  } finally {
    await session.close();
  }
}

/**
 * Seed a songwriter fixture (#380) for the explore + reconciliation tests. Call AFTER seedGraph().
 * Writes the post-reconciliation end state directly (the same shapes the mb-artist-id +
 * songwriter-reconciliation passes produce): a person present as BOTH an Artist and a Musician
 * (SAME_PERSON_AS-linked, both carrying `musicbrainzId`), a Work whose captured `writerMbids` name
 * that MBID, a `WROTE` edge tagged with the writer roles, and an in-collection recording of the
 * Work. discogsIds ≥ 900600 + a distinct name so it doesn't perturb the other explore assertions.
 */
export async function seedSongwriters(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (a:Artist {discogsId: 900600})
         SET a.name = 'Test Songwriter', a.musicbrainzId = 'mb-songwriter-1'
       MERGE (m:Musician {discogsId: 900600})
         SET m.name = 'Test Songwriter', m.musicbrainzId = 'mb-songwriter-1'
       MERGE (m)-[:SAME_PERSON_AS]->(a)
       MERGE (w:Work {mbid: 'work-songwriter-1'})
         SET w.title = 'A Written Song', w.type = 'Song',
             w.writers = ['Test Songwriter'], w.writerMbids = ['mb-songwriter-1'],
             w.writerRoles = ['composer']
       MERGE (r:Release {discogsId: 7060001})
         SET r.title = 'Songwriter LP', r.pressingYear = 1972
       MERGE (t:Track {position: 'A1', releaseDiscogsId: 7060001})
         SET t.title = 'A Written Song', t.recordingMbid = 'rec-songwriter-1'
       MERGE (r)-[:HAS_TRACK]->(t)
       MERGE (t)-[rof:RECORDING_OF]->(w) SET rof.source = 'musicbrainz'
       MERGE (a)-[wa:WROTE]->(w) SET wa.source = 'musicbrainz', wa.roles = ['composer']
       MERGE (m)-[wm:WROTE]->(w) SET wm.source = 'musicbrainz', wm.roles = ['composer']`,
    );
  } finally {
    await session.close();
  }
}

/**
 * Seed entity-resolution fixtures (#330) for the explore + reconciliation tests. Call AFTER
 * seedGraph(). All entities use discogsIds ≥ 900000 and distinct names so they don't perturb the
 * other explore assertions (which match by their own names / use `>=` bounds). Writes the same
 * node/relationship shapes the production writers do, via direct Cypher:
 *
 *   - alias case:  a Musician credited at TRACK scope under an alias name, SAME_PERSON_AS-linked to
 *     an Artist whose canonical name differs → exercises track-scope inclusion + alias==canonical.
 *   - group case:  a group Musician credited release-scope, two member Musicians credited on other
 *     releases, linked via MEMBER_OF → exercises group↔member expansion both directions.
 *   - reconcile:   a Musician + Artist sharing a discogsId with NO SAME_PERSON_AS yet → the
 *     person-reconciliation pass must create the edge.
 */
export async function seedEntityResolution(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    // alias: "Jimmy Test (4)" (Musician) ≡ "Jimmy Test" (Artist), track-scope credit on A1.
    await session.run(
      `MERGE (a:Artist {discogsId: 900200}) SET a.name = 'Jimmy Test'
       MERGE (m:Musician {discogsId: 900200}) SET m.name = 'Jimmy Test (4)'
       MERGE (m)-[:SAME_PERSON_AS]->(a)
       WITH m
       MATCH (t:Track {position: 'A1', releaseDiscogsId: 7000001})
       MERGE (m)-[co:CREDITED_ON]->(t)
       SET co.role = 'Guitar', co.displayRole = 'Guitar', co.roleCategory = 'performer',
           co.creditedAs = null, co.scope = 'track'`,
    );
    // group: "The Test Swampers" credited release-scope on 7000001.
    await session.run(
      `MERGE (g:Musician {discogsId: 900300}) SET g.name = 'The Test Swampers'
       WITH g MATCH (r:Release {discogsId: 7000001})
       MERGE (g)-[co:CREDITED_ON]->(r)
       SET co.role = 'Rhythm Section', co.displayRole = 'Rhythm Section',
           co.roleCategory = 'performer', co.creditedAs = null, co.scope = 'release'`,
    );
    // members credited on other releases, linked via MEMBER_OF to the group.
    await session.run(
      `UNWIND [
         {discogsId: 900301, name: 'Test Hood', release: 7000002, active: true},
         {discogsId: 900302, name: 'Test Hawkins', release: 7000003, active: false}
       ] AS mem
       MERGE (m:Musician {discogsId: mem.discogsId}) SET m.name = mem.name
       WITH m, mem
       MATCH (g:Musician {discogsId: 900300})
       MERGE (m)-[rel:MEMBER_OF]->(g) SET rel.active = mem.active
       WITH m, mem
       MATCH (r:Release {discogsId: mem.release})
       MERGE (m)-[co:CREDITED_ON]->(r)
       SET co.role = 'Bass', co.displayRole = 'Bass', co.roleCategory = 'performer',
           co.creditedAs = null, co.scope = 'release'`,
    );
    // reconcile: Musician + Artist sharing a discogsId, deliberately UNLINKED.
    await session.run(
      `MERGE (a:Artist {discogsId: 900400}) SET a.name = 'Reconcile Me'
       MERGE (m:Musician {discogsId: 900400}) SET m.name = 'Reconcile Me'`,
    );
    // shared-musicians alias collapse: an aliased person credited on two releases — should appear in
    // the (7000004, 7000005) pair once, under the canonical Artist name (not the alias node name).
    await session.run(
      `MERGE (a:Artist {discogsId: 900500}) SET a.name = 'Canonical Person'
       MERGE (m:Musician {discogsId: 900500}) SET m.name = 'Canon Alias'
       MERGE (m)-[:SAME_PERSON_AS]->(a)
       WITH m
       UNWIND [7000004, 7000005] AS rid
       MATCH (r:Release {discogsId: rid})
       MERGE (m)-[co:CREDITED_ON]->(r)
       SET co.role = 'Piano', co.displayRole = 'Piano', co.roleCategory = 'performer',
           co.creditedAs = null, co.scope = 'release'`,
    );
  } finally {
    await session.close();
  }
}
