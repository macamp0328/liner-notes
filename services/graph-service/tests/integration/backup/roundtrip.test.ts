import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';
import { initTestDriver } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { exportGraph } from '../../../src/backup/export.js';
import {
  collectBackup,
  restoreGraph,
  countGraph,
  splitJsonlLines,
  verifyRestore,
} from '../../../src/backup/restore.js';
import { encodeProps } from '../../../src/backup/serialize.js';

/**
 * The #104 acceptance proof: seed a graph exercising the whole property-type surface, export
 * it through the real streaming path, wipe, restore through the real replay path, and assert
 * the result is indistinguishable from the original — counts AND property values (compared on
 * their encoded form, which is exact for Integer/temporal types where JS equality is not).
 * No S3 involved: the export sink is an in-memory collector, exactly the seam prod pipes
 * into gzip → S3.
 */

// Property fixture spanning every type the graph uses (plus a few it doesn't yet):
// strings, booleans, floats, Integers (incl. > 2^53), datetime with zone, date, duration,
// arrays (string + int), and a null-free shape (Neo4j never stores nulls).
const RELEASE_PROPS = {
  title: 'Horses',
  // the U+2028/U+2029 regression: real Discogs profile text contains raw Unicode line
  // separators, which must survive export → any line splitter → restore intact
  linerNotes: 'side one\u2028side two\u2029end',
  discogsId: neo4j.int(999001),
  bigCount: neo4j.int('9007199254740995'),
  confidence: 0.85,
  isFavorite: true,
  fetchedAt: new neo4j.types.DateTime(
    2026,
    7,
    16,
    10,
    30,
    0,
    123456789,
    -14400,
    'America/New_York',
  ),
  releasedOn: new neo4j.types.Date(1975, 11, 10),
  sideLength: new neo4j.types.Duration(0, 0, 2580, 0),
  genres: ['Rock', 'Punk'],
  ratings: [neo4j.int(5), neo4j.int(4)],
};

const CREDIT_PROPS = {
  role: 'Guitar',
  scope: 'release',
  weight: 0.5,
  since: neo4j.int(1974),
};

function collector(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { sink, text: () => chunks.join('') };
}

async function readProps(driver: Driver, cypher: string): Promise<Record<string, unknown>> {
  const session = driver.session();
  try {
    const res = await session.run(cypher);
    expect(res.records).toHaveLength(1);
    return (res.records[0]!.get('p') as { properties: Record<string, unknown> }).properties;
  } finally {
    await session.close();
  }
}

describe('backup export → wipe → restore round-trip (real Neo4j)', () => {
  let driver: Driver;

  beforeAll(async () => {
    driver = initTestDriver();
    await clearGraph(driver);
  });

  afterAll(async () => {
    await clearGraph(driver);
  });

  it('restores an identical graph, byte-identical on encoded properties', async () => {
    // -- seed ---------------------------------------------------------------
    const session = driver.session();
    try {
      await session.run(
        `CREATE (r:Release $releaseProps)
         CREATE (am:Artist:Musician {name: 'Patti Smith', discogsId: 999002})
         CREATE (g:Genre {name: 'Punk'})
         CREATE (naked {note: 'zero-label node'})
         CREATE (am)-[:CREDITED_ON $creditProps]->(r)
         CREATE (r)-[:IN_GENRE]->(g)
         CREATE (naked)-[:POINTS_AT {why: 'exercise odd shapes'}]->(r)`,
        { releaseProps: RELEASE_PROPS, creditProps: CREDIT_PROPS },
      );
    } finally {
      await session.close();
    }
    const originalRelease = await readProps(driver, `MATCH (p:Release {title: 'Horses'}) RETURN p`);

    // -- export -------------------------------------------------------------
    const { sink, text } = collector();
    const manifest = await exportGraph(driver, sink, { sourceHost: 'integration-test' });
    expect(manifest.nodeCount).toBe(4);
    expect(manifest.relCount).toBe(3);
    expect(manifest.labelCounts).toEqual({
      Release: 1,
      'Artist:Musician': 1,
      Genre: 1,
      '(none)': 1,
    });
    expect(manifest.relTypeCounts).toEqual({ CREDITED_ON: 1, IN_GENRE: 1, POINTS_AT: 1 });

    // -- wipe ---------------------------------------------------------------
    await clearGraph(driver);
    expect(await countGraph(driver)).toEqual({ nodes: 0, rels: 0 });

    // -- restore ------------------------------------------------------------
    // Same splitter the operator script uses — the U+2028 fixture proves the whole path.
    const backup = await collectBackup(splitJsonlLines([text()]));
    expect(backup.manifest).toEqual(manifest);
    const result = await restoreGraph(driver, backup);
    const after = await countGraph(driver);
    expect(verifyRestore(backup.manifest, result, after)).toEqual([]);

    // -- fidelity -----------------------------------------------------------
    // Encoded-form equality is exact where JS deep-equality on driver objects is not
    // (Integer low/high vs number fields, DateTime internals).
    const restoredRelease = await readProps(driver, `MATCH (p:Release {title: 'Horses'}) RETURN p`);
    expect(encodeProps(restoredRelease)).toEqual(encodeProps(originalRelease));
    expect(encodeProps(restoredRelease)).toEqual(encodeProps(RELEASE_PROPS));

    const restoredCredit = await readProps(
      driver,
      `MATCH (:Artist:Musician {name: 'Patti Smith'})-[p:CREDITED_ON]->(:Release) RETURN p`,
    );
    expect(encodeProps(restoredCredit)).toEqual(encodeProps(CREDIT_PROPS));

    // the zero-label node came back label-free (no leftover _LnRestore) and re-linked
    const naked = await readProps(
      driver,
      `MATCH (p)-[:POINTS_AT]->(:Release) WHERE size(labels(p)) = 0 RETURN p`,
    );
    expect(naked['note']).toBe('zero-label node');
    expect(naked['_lnBackupId']).toBeUndefined();

    // multi-label set survived exactly
    const labelSession = driver.session();
    try {
      const res = await labelSession.run(`MATCH (n {name: 'Patti Smith'}) RETURN labels(n) AS l`);
      expect((res.records[0]!.get('l') as string[]).sort()).toEqual(['Artist', 'Musician']);
    } finally {
      await labelSession.close();
    }
  });

  it('a second export of the restored graph produces the same manifest (stable round-trip)', async () => {
    const { sink, text } = collector();
    const manifest = await exportGraph(driver, sink);
    expect(manifest.nodeCount).toBe(4);
    expect(manifest.relCount).toBe(3);
    // and the file it wrote parses cleanly end-to-end
    const backup = await collectBackup(text().split('\n'));
    expect(backup.nodes).toHaveLength(4);
    expect(backup.rels).toHaveLength(3);
  });
});
