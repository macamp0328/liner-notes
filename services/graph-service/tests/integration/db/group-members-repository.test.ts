import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import {
  getGroupCandidates,
  setGroupMembers,
  markNotAGroup,
  resetGroupMembers,
} from '../../../src/db/group-members-repository.js';

/**
 * Exercises the production group-members Cypher against a REAL Neo4j — the unit tests only assert
 * query substrings against a mocked session, so the load-bearing write semantics (stamp-even-when-
 * no-member-matches, MATCH-only no-phantom, the staleness throttle, reset) are only proven here.
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

async function candidateIds(): Promise<number[]> {
  const candidates = await getGroupCandidates(getDriver());
  return candidates.map((c) => c.discogsId).sort((a, b) => a - b);
}

/**
 * Run `fn` with the staleness window pinned, restoring the prior value after. `'0'` makes every
 * already-stamped node count as stale (see getStalenessDays), which isolates the permanent
 * `notAGroup` marker as the reason a confirmed non-group is excluded — not the staleness throttle.
 */
async function withStalenessDays(days: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env['ENRICHMENT_STALENESS_DAYS'];
  process.env['ENRICHMENT_STALENESS_DAYS'] = days;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env['ENRICHMENT_STALENESS_DAYS'];
    else process.env['ENRICHMENT_STALENESS_DAYS'] = prev;
  }
}

const GROUP = 970001;
const MEMBER = 970002; // collected (has a Musician node)
const UNCOLLECTED = 970003; // no Musician node

describe('group-members repository (#330, integration)', () => {
  let app: FastifyInstance;
  let originalStaleness: string | undefined;

  beforeAll(async () => {
    app = await buildTestServer();
    // Pin the default 30-day window so a just-stamped node is throttled out of the candidate set.
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
    // A group + one collected member; UNCOLLECTED deliberately has no node.
    await write(
      `CREATE (:Musician {discogsId: ${GROUP}, name: 'Grp'}), (:Musician {discogsId: ${MEMBER}, name: 'Mem'})`,
    );
  });

  it('selects every Musician-with-discogsId that has not been members-fetched', async () => {
    expect(await candidateIds()).toEqual([GROUP, MEMBER]);
  });

  it('links collected members MATCH-only, creates no phantom node, and stamps the group', async () => {
    await setGroupMembers(getDriver(), GROUP, [
      { id: MEMBER, active: true },
      { id: UNCOLLECTED, active: false },
    ]);

    expect(
      await bool(
        `MATCH (m:Musician {discogsId: ${MEMBER}})-[r:MEMBER_OF]->(:Musician {discogsId: ${GROUP}})
         RETURN r.active = true AS v`,
      ),
    ).toBe(true);
    expect(await bool(`RETURN EXISTS { (:Musician {discogsId: ${UNCOLLECTED}}) } AS v`)).toBe(
      false,
    );
    expect(
      await bool(
        `MATCH (g:Musician {discogsId: ${GROUP}}) RETURN g.membersFetchedAt IS NOT NULL AS v`,
      ),
    ).toBe(true);
    // throttle: the stamped group drops out of the candidate set; the member (unstamped) remains.
    expect(await candidateIds()).toEqual([MEMBER]);
  });

  it('stamps the group even when NO member matches (so an all-uncollected group is not re-fetched)', async () => {
    await setGroupMembers(getDriver(), GROUP, [{ id: UNCOLLECTED, active: true }]);
    expect(
      await bool(
        `MATCH (g:Musician {discogsId: ${GROUP}}) RETURN g.membersFetchedAt IS NOT NULL AS v`,
      ),
    ).toBe(true);
    expect(
      await bool(
        `RETURN EXISTS { (:Musician)-[:MEMBER_OF]->(:Musician {discogsId: ${GROUP}}) } AS v`,
      ),
    ).toBe(false);
    expect(await candidateIds()).toEqual([MEMBER]);
  });

  it('creates no self-loop when a roster lists the group itself', async () => {
    await setGroupMembers(getDriver(), GROUP, [{ id: GROUP, active: true }]);
    expect(
      await bool(`RETURN EXISTS { (g:Musician {discogsId: ${GROUP}})-[:MEMBER_OF]->(g) } AS v`),
    ).toBe(false);
  });

  it('markNotAGroup excludes a confirmed non-group musician from the candidate set', async () => {
    await markNotAGroup(getDriver(), MEMBER);
    expect(await candidateIds()).toEqual([GROUP]);
  });

  it('permanently skips a confirmed non-group while a known group re-checks once stale', async () => {
    await withStalenessDays('0', async () => {
      // GROUP is a real group (one collected member → one MEMBER_OF edge, notAGroup left unset);
      // MEMBER is confirmed a person (Discogs returned no members[] → markNotAGroup).
      await setGroupMembers(getDriver(), GROUP, [{ id: MEMBER, active: true }]);
      await markNotAGroup(getDriver(), MEMBER);
      // Both are members-fetched and now stale, yet only the group re-checks for lineup changes:
      // the non-group is excluded by its permanent notAGroup marker, NOT by the staleness throttle.
      expect(await candidateIds()).toEqual([GROUP]);
      expect(
        await bool(`MATCH (m:Musician {discogsId: ${MEMBER}}) RETURN m.notAGroup = true AS v`),
      ).toBe(true);
    });
  });

  it('keeps an all-uncollected group in the stale re-check but not a confirmed non-group', async () => {
    await withStalenessDays('0', async () => {
      // GROUP is a group whose only member is uncollected → fetched + stamped, but 0 edges written
      // and notAGroup left unset (it IS a group). MEMBER is a confirmed non-group.
      await setGroupMembers(getDriver(), GROUP, [{ id: UNCOLLECTED, active: true }]);
      await markNotAGroup(getDriver(), MEMBER);
      // The edge-less group stays a candidate (notAGroup unset → re-checks, so MEMBER_OF backfills
      // when its members are later collected); the non-group is gone for good.
      expect(await candidateIds()).toEqual([GROUP]);
      expect(
        await bool(`MATCH (g:Musician {discogsId: ${GROUP}}) RETURN g.notAGroup IS NULL AS v`),
      ).toBe(true);
    });
  });

  it('resetGroupMembers deletes MEMBER_OF edges and clears BOTH markers (incl. notAGroup)', async () => {
    // GROUP gets an edge + membersFetchedAt; MEMBER is a confirmed non-group (notAGroup = true).
    await setGroupMembers(getDriver(), GROUP, [{ id: MEMBER, active: true }]);
    await markNotAGroup(getDriver(), MEMBER);
    expect(
      await bool(`MATCH (m:Musician {discogsId: ${MEMBER}}) RETURN m.notAGroup = true AS v`),
    ).toBe(true);

    const cleared = await resetGroupMembers(getDriver());
    expect(cleared).toBeGreaterThan(0);
    expect(await bool(`RETURN EXISTS { (:Musician)-[:MEMBER_OF]->(:Musician) } AS v`)).toBe(false);
    // The permanent non-group marker is cleared too, so the once-confirmed non-group is a
    // first-sweep candidate again and the next reload re-fetches everything.
    expect(
      await bool(`MATCH (m:Musician {discogsId: ${MEMBER}}) RETURN m.notAGroup IS NULL AS v`),
    ).toBe(true);
    expect(await candidateIds()).toEqual([GROUP, MEMBER]);
  });
});
