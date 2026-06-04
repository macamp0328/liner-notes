import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { mergeReleaseGraph } from '../../src/db/ingestion-repository.js';
import type { DiscogsRelease } from '../../src/ingestion/types.js';

const releasesDir = join(dirname(fileURLToPath(import.meta.url)), 'releases');

/** All seed releases, ordered deterministically by filename. */
function loadReleases(): DiscogsRelease[] {
  return readdirSync(releasesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(releasesDir, name), 'utf8')) as DiscogsRelease);
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
    // Give those three musicians distinct origin countries. The country names are
    // synthetic test values chosen to exercise multi-country ranking — they are
    // NOT the musicians' real nationalities.
    await session.run(
      `UNWIND [
         {discogsId: 500001, country: 'US'},
         {discogsId: 500003, country: 'France'},
         {discogsId: 500004, country: 'Japan'}
       ] AS n
       MATCH (m:Musician {discogsId: n.discogsId})
       MERGE (c:Country {name: n.country})
       MERGE (m)-[:ORIGIN_COUNTRY]->(c)
       SET m.nationalityFetched = true`,
    );

    // --- most-pressed --------------------------------------------------------
    // mergeReleaseGraph does not create Master nodes; create the Maiden Voyage
    // master (800001) released in three countries via RELEASED_IN (the rel the
    // route matches — not MB_RELEASED_IN).
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
