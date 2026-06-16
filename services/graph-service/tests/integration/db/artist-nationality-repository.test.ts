import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { setMusicianNationality } from '../../../src/db/artist-nationality-repository.js';

/**
 * Exercises setMusicianNationality's identity-precedence write against a REAL Neo4j (#426).
 * The unit tests only assert query substrings against a mocked session, so the load-bearing
 * fact — that two same-named, distinct-MBID no-discogsId Musicians get their OWN country and
 * are not cross-contaminated — is only provable here. Under the old name-keyed write the
 * MERGE/SET applied to every same-named node; the count-is-1 and untouched-node assertions
 * below would both fail.
 */
async function write(cypher: string): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(cypher);
  } finally {
    await session.close();
  }
}

async function bool(cypher: string): Promise<boolean> {
  const session = getDriver().session();
  try {
    const res = await session.run(cypher);
    return res.records[0]?.get('v') === true;
  } finally {
    await session.close();
  }
}

async function countriedCount(): Promise<number> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (:Musician {name: 'John Williams'})-[:ORIGIN_COUNTRY]->() RETURN count(*) AS v`,
    );
    return (res.records[0]?.get('v') as { toNumber(): number }).toNumber();
  } finally {
    await session.close();
  }
}

async function countryOf(mbid: string): Promise<string | null> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (m:Musician {musicbrainzId: $mbid})
       OPTIONAL MATCH (m)-[:ORIGIN_COUNTRY]->(c:Country)
       RETURN c.name AS v`,
      { mbid },
    );
    return (res.records[0]?.get('v') as string | null) ?? null;
  } finally {
    await session.close();
  }
}

const NAME = 'John Williams'; // the canonical same-name collision (film composer vs guitarist)
const MBID_A = 'mbid-aaa';
const MBID_B = 'mbid-bbb';

describe('setMusicianNationality identity precedence (#426, integration)', () => {
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
    // Two distinct MusicBrainz artists, SAME name, no discogsId — the MBID-keyed fallback
    // Musicians track-recording-artists introduces (#420/#418).
    await write(
      `CREATE (:Musician {name: '${NAME}', musicbrainzId: '${MBID_A}'})
       CREATE (:Musician {name: '${NAME}', musicbrainzId: '${MBID_B}'})`,
    );
  });

  it('writes ORIGIN_COUNTRY to only the MBID-matched node, never the same-named distinct-MBID node', async () => {
    await setMusicianNationality(
      getDriver(),
      { discogsId: null, name: NAME, musicbrainzId: MBID_A },
      'US',
      'musicbrainz',
    );

    // The cleanest expression of the acceptance criterion: exactly ONE of the two same-named
    // nodes is countried (the old name-keyed write countried both → 2).
    expect(await countriedCount()).toBe(1);
    expect(await countryOf(MBID_A)).toBe('US');
    expect(await countryOf(MBID_B)).toBeNull();

    // Cause-level: node B keeps a null nationalityFetchedAt, so it stays a candidate for its
    // own MBID lookup instead of being throttled out by a contaminated stamp.
    expect(
      await bool(
        `MATCH (m:Musician {musicbrainzId: '${MBID_A}'}) RETURN m.nationalityFetchedAt IS NOT NULL AS v`,
      ),
    ).toBe(true);
    expect(
      await bool(
        `MATCH (m:Musician {musicbrainzId: '${MBID_B}'}) RETURN m.nationalityFetchedAt IS NULL AS v`,
      ),
    ).toBe(true);

    // Resolving B under its own MBID gives it a distinct country, leaving A untouched.
    await setMusicianNationality(
      getDriver(),
      { discogsId: null, name: NAME, musicbrainzId: MBID_B },
      'JP',
      'musicbrainz',
    );
    expect(await countryOf(MBID_A)).toBe('US');
    expect(await countryOf(MBID_B)).toBe('JP');
  });

  it('null-country markAttempted stamps only the MBID-matched node (no staleness contamination)', async () => {
    await setMusicianNationality(
      getDriver(),
      { discogsId: null, name: NAME, musicbrainzId: MBID_A },
      null,
      null,
    );

    // The markAttempted path shares the same match clause: only A's nationalityFetchedAt is
    // stamped, so B is not silently throttled out of the next candidate sweep.
    expect(
      await bool(
        `MATCH (m:Musician {musicbrainzId: '${MBID_A}'}) RETURN m.nationalityFetchedAt IS NOT NULL AS v`,
      ),
    ).toBe(true);
    expect(
      await bool(
        `MATCH (m:Musician {musicbrainzId: '${MBID_B}'}) RETURN m.nationalityFetchedAt IS NULL AS v`,
      ),
    ).toBe(true);
    expect(await countriedCount()).toBe(0);
  });
});
