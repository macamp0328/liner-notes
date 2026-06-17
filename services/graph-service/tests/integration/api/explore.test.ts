import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import {
  seedGraph,
  clearGraph,
  seedExploreEnrichment,
  seedEntityResolution,
  seedWorks,
  seedSongwriters,
  seedInfluences,
} from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';
import { linkInfluencedBy } from '../../../src/db/artist-influences-repository.js';

const SEED_RELEASE_ID = 7000001; // Maiden Voyage — Herbie Hancock, Blue Note, US, 1966

describe('explore routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
    await clearGraph(getDriver());
    await seedGraph(getDriver());
    await seedExploreEnrichment(getDriver());
    await seedEntityResolution(getDriver());
    await seedWorks(getDriver());
    await seedSongwriters(getDriver());
    await seedInfluences(getDriver());
    // Drive the real projection so the route reads production-shaped INFLUENCED_BY edges (#391).
    await linkInfluencedBy(getDriver());
  });

  afterAll(async () => {
    await clearGraph(getDriver());
    await app.close();
  });

  describe('GET /api/v1/explore/musician/:name', () => {
    it('returns releases for a known musician', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/musician/Ron%20Carter' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number; instrument: string | null }[];
      expect(body.length).toBeGreaterThanOrEqual(2);
      expect(body.every((r) => typeof r.discogsId === 'number')).toBe(true);
    });

    it('returns an empty array for an unknown musician', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/__nobody__',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/v1/explore/producer/:name', () => {
    it('returns releases for a known producer', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/producer/Butch%20Vig' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number; role: string | null }[];
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((r) => r.role === 'producer')).toBe(true);
    });

    it('returns an empty array for a name not credited as a producer', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/producer/__nobody__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });

    it('surfaces a track-scoped MB production credit via the HAS_TRACK roll-up (#339)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/producer/Track%20Producer%20Person',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number; role: string | null }[];
      // Credited only at TRACK scope on a track of 7000001 — release-only matching would drop it.
      expect(body.map((r) => r.discogsId)).toContain(7000001);
      expect(body.every((r) => r.role === 'producer')).toBe(true);
    });
  });

  describe('GET /api/v1/explore/engineer/:name', () => {
    it('returns releases for a known engineer', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/engineer/Bill%20Price' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number; role: string | null }[];
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((r) => r.role === 'engineer')).toBe(true);
    });

    it('returns an empty array for a name not credited as an engineer', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/engineer/__nobody__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });

    it('surfaces a track-scoped MB engineer credit via the HAS_TRACK roll-up (#339)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/engineer/Track%20Engineer%20Person',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number; role: string | null }[];
      expect(body.map((r) => r.discogsId)).toContain(7000001);
      expect(body.every((r) => r.role === 'engineer')).toBe(true);
    });
  });

  describe('GET /api/v1/explore/instrument/:name', () => {
    interface InstrumentCreditBody {
      musician: string;
      instrument: string | null;
      displayRole: string | null;
    }
    interface InstrumentPlayerBody {
      discogsId: number;
      name: string;
      playsInstrument: string[];
    }
    interface InstrumentExplorationBody {
      credits: InstrumentCreditBody[];
      players: InstrumentPlayerBody[];
    }

    it('returns per-credit musicians (credits) for a normalized instrument', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/instrument/bass' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InstrumentExplorationBody;
      expect(body.credits.length).toBeGreaterThan(0);
      expect(body.credits.every((r) => r.instrument === 'bass')).toBe(true);
      expect(body.credits.some((r) => r.musician === 'Ron Carter')).toBe(true);
    });

    it('returns person-level players from Wikidata P1303 (#393)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/instrument/bass' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InstrumentExplorationBody;
      const player = body.players.find((p) => p.name === 'Multi Instrumentalist');
      expect(player).toBeDefined();
      expect(player!.playsInstrument).toContain('bass');
    });

    it('collapses a specific Discogs spelling onto its family', async () => {
      // George Coleman is credited verbatim as "Tenor Saxophone"; the normalized
      // instrument axis answers the broader "saxophone" query.
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/instrument/saxophone' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InstrumentExplorationBody;
      expect(
        body.credits.some(
          (r) => r.musician === 'George Coleman' && r.displayRole === 'Tenor Saxophone',
        ),
      ).toBe(true);
    });

    it('is case-insensitive on the instrument name (both axes)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/instrument/Bass' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InstrumentExplorationBody;
      expect(body.credits.length).toBeGreaterThan(0);
      expect(body.players.some((p) => p.name === 'Multi Instrumentalist')).toBe(true);
    });

    it('returns empty credits and players for an instrument nobody plays', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/instrument/harp' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ credits: [], players: [] });
    });
  });

  // #336: linking is purely on the shared Work MBID — these cases encode the acceptance criteria.
  describe('GET /api/v1/explore/work/:mbid', () => {
    type WorkRecordingBody = { recordingMbid: string; discogsId: number; trackTitle: string };

    it('groups two distinct recordings of one Work as versions/covers', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/work/work-cover-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as WorkRecordingBody[];
      expect(body).toHaveLength(2);
      // two DISTINCT recordings → a real cover pair
      expect(new Set(body.map((r) => r.recordingMbid))).toEqual(
        new Set(['rec-cover-a', 'rec-cover-b']),
      );
    });

    it('returns the same recording on two releases (a duplicate, not two versions)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/work/work-dup-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as WorkRecordingBody[];
      expect(body).toHaveLength(2);
      // one DISTINCT recording across both releases → a duplicate, not a cover
      expect(new Set(body.map((r) => r.recordingMbid))).toEqual(new Set(['rec-dup']));
      expect(new Set(body.map((r) => r.discogsId))).toEqual(new Set([7050003, 7050004]));
    });

    it('does NOT link two same-titled recordings that are different Works', async () => {
      const a = await app.inject({ method: 'GET', url: '/api/v1/explore/work/work-collide-a' });
      const b = await app.inject({ method: 'GET', url: '/api/v1/explore/work/work-collide-b' });
      const bodyA = JSON.parse(a.payload) as WorkRecordingBody[];
      const bodyB = JSON.parse(b.payload) as WorkRecordingBody[];
      expect(bodyA.map((r) => r.recordingMbid)).toEqual(['rec-collide-a']);
      expect(bodyB.map((r) => r.recordingMbid)).toEqual(['rec-collide-b']);
    });

    it('returns an empty array for an unknown Work', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/work/__none__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  // #380: WROTE edges joined deterministically on musicbrainzId, surfaced by composer name.
  describe('GET /api/v1/explore/songwriter/:name', () => {
    type SongwriterBody = { workMbid: string; workTitle: string; roles: string[] };

    it('returns the compositions a person wrote, with the recording and roles', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/songwriter/Test%20Songwriter',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as SongwriterBody[];
      // One row (the SAME_PERSON_AS Artist/Musician pair is DISTINCT-collapsed).
      expect(body).toHaveLength(1);
      expect(body[0]?.workMbid).toBe('work-songwriter-1');
      expect(body[0]?.roles).toEqual(['composer']);
    });

    it('matches case-insensitively', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/songwriter/test%20songwriter',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });

    it('returns an empty array for a name with no WROTE edges', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/songwriter/__nobody__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  // #391: Wikidata P737 influence graph, projected into in-collection INFLUENCED_BY edges.
  describe('GET /api/v1/explore/influences/:name', () => {
    type InfluencesBody = {
      influencedBy: Array<{ discogsId: number; name: string; wikidataQid: string }>;
      influenced: Array<{ discogsId: number; name: string; wikidataQid: string }>;
    };

    it('returns both directions of the influence neighbourhood', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/influences/Influence%20Beta',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InfluencesBody;
      // Beta was influenced by Gamma (the unowned QID was dropped by the confidence gate)...
      expect(body.influencedBy).toEqual([
        { discogsId: 970003, name: 'Influence Gamma', wikidataQid: 'Q-inf-gamma' },
      ]);
      // ...and Beta influenced Alpha (incoming edge).
      expect(body.influenced).toEqual([
        { discogsId: 970001, name: 'Influence Alpha', wikidataQid: 'Q-inf-alpha' },
      ]);
    });

    it('matches case-insensitively', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/influences/influence%20gamma',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InfluencesBody;
      // Gamma influenced Beta; nothing in-collection influenced Gamma.
      expect(body.influenced).toEqual([
        { discogsId: 970002, name: 'Influence Beta', wikidataQid: 'Q-inf-beta' },
      ]);
      expect(body.influencedBy).toEqual([]);
    });

    it('returns empty arrays for a name with no influence edges', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/influences/__nobody__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ influencedBy: [], influenced: [] });
    });

    it('unions both nodes when two distinct artists share a name (Artist.name is not unique)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/influences/Influence%20Dup',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as InfluencesBody;
      // dup1 was influenced by Delta, dup2 by Epsilon — both nodes' edges must appear, not just one.
      const names = body.influencedBy.map((x) => x.name).sort();
      expect(names).toEqual(['Influence Delta', 'Influence Epsilon']);
    });
  });

  describe('GET /api/v1/explore/studio/:name', () => {
    it('returns releases for a known studio', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/studio/Van%20Gelder%20Studio',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns an empty array for an unknown studio', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/studio/__none__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/v1/explore/recording-locations', () => {
    interface MapStudio {
      name: string;
      latitude: number;
      longitude: number;
      area: string | null;
      musicbrainzPlaceId: string | null;
      releaseCount: number;
      trackCount: number;
    }

    beforeAll(async () => {
      // Give one studio MB-style coordinates and a release-level RECORDED_AT edge to the seeded
      // release, so it pins with releaseCount >= 1. The seeded "Van Gelder Studio" stays
      // coordinate-less, so it must be ABSENT from the map — the honest-no-pin behaviour.
      const session = getDriver().session();
      try {
        await session.run(
          `MATCH (r:Release {discogsId: $rid})
           MERGE (s:Studio { name: 'Abbey Road Studios' })
             SET s.latitude = $lat, s.longitude = $lon,
                 s.area = $area, s.musicbrainzPlaceId = $placeId
           MERGE (r)-[:RECORDED_AT]->(s)`,
          {
            rid: SEED_RELEASE_ID,
            lat: 51.53192,
            lon: -0.17835,
            area: "St John's Wood",
            placeId: 'place-itest-342',
          },
        );
      } finally {
        await session.close();
      }
    });

    it('returns studios with coordinates, sized by release count, omitting unplaced studios', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/recording-locations' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as MapStudio[];

      const abbeyRoad = body.find((s) => s.name === 'Abbey Road Studios');
      expect(abbeyRoad).toBeDefined();
      expect(abbeyRoad!.latitude).toBeCloseTo(51.53192, 4);
      expect(abbeyRoad!.longitude).toBeCloseTo(-0.17835, 4);
      expect(abbeyRoad!.area).toBe("St John's Wood");
      expect(abbeyRoad!.releaseCount).toBeGreaterThanOrEqual(1);

      // Every pin has coordinates; the coordinate-less Van Gelder Studio is omitted.
      expect(body.every((s) => s.latitude !== null && s.longitude !== null)).toBe(true);
      expect(body.some((s) => s.name === 'Van Gelder Studio')).toBe(false);
    });
  });

  describe('GET /api/v1/explore/label/:name', () => {
    it('returns releases on a known label', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/label/Blue%20Note%20Records',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns an empty array for an unknown label', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/label/__none__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/v1/explore/genre/:name', () => {
    it('returns releases for a known genre', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/genre/Jazz' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns an empty array for an unknown genre', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/genre/__none__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/v1/explore/style/:name', () => {
    it('returns releases for a known style', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/style/Hard%20Bop' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns an empty array for an unknown style', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/style/__none__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/v1/explore/country/:name', () => {
    it('returns releases for a known country', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/country/US' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns an empty array for an unknown country', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/country/__none__' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('GET /api/v1/explore/decade/:decade', () => {
    it('returns releases for a valid decade', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/1970s' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns 400 for a malformed decade', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/19700' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({
        error: { code: 'INVALID_DECADE', message: 'decade must be in the format 1970s' },
      });
    });
  });

  describe('GET /api/v1/explore/year/:year', () => {
    it('returns releases for a known year', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/year/1966' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { discogsId: number }[];
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns 400 for a non-numeric year via schema coercion', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/year/abcd' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/explore/connections/:discogsId', () => {
    it('returns the seed release and reachable nodes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/explore/connections/${SEED_RELEASE_ID}?depth=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        seed: { discogsId: number };
        nodes: { type: string }[];
      };
      expect(body.seed.discogsId).toBe(SEED_RELEASE_ID);
      expect(body.nodes.length).toBeGreaterThan(0);
    });

    it('returns 404 when the seed release is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/connections/1' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for depth outside [1,3]', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/explore/connections/${SEED_RELEASE_ID}?depth=5`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/explore/shared-musicians', () => {
    it('returns at least one overlapping pair from the seed data (Ron Carter)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/shared-musicians' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        releaseA: { discogsId: number };
        releaseB: { discogsId: number };
        sharedMusicians: { name: string }[];
      }[];
      expect(body.length).toBeGreaterThan(0);
      const ronCarterPair = body.find((p) =>
        p.sharedMusicians.some((m) => m.name === 'Ron Carter'),
      );
      expect(ronCarterPair).toBeDefined();
    });

    it('collapses an alias to the canonical Artist name (#330)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/explore/shared-musicians' });
      const body = JSON.parse(res.payload) as {
        releaseA: { discogsId: number };
        releaseB: { discogsId: number };
        sharedMusicians: { name: string }[];
      }[];
      // The aliased person (Musician "Canon Alias" ≡ Artist "Canonical Person") is credited on
      // 7000004 + 7000005 → the pair lists them once, under the canonical name, not the alias node.
      const pair = body.find(
        (p) =>
          (p.releaseA.discogsId === 7000004 && p.releaseB.discogsId === 7000005) ||
          (p.releaseA.discogsId === 7000005 && p.releaseB.discogsId === 7000004),
      );
      expect(pair).toBeDefined();
      expect(pair!.sharedMusicians.map((m) => m.name)).toContain('Canonical Person');
      expect(pair!.sharedMusicians.map((m) => m.name)).not.toContain('Canon Alias');
    });
  });

  describe('GET /api/v1/explore/musician/:name — entity resolution (#330)', () => {
    const ids = (payload: string): number[] =>
      (JSON.parse(payload) as { discogsId: number }[]).map((r) => r.discogsId);

    it('includes track-scoped credits (the Dixie Hummingbirds / Jimmy Johnson bug)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/Jimmy%20Test%20(4)',
      });
      expect(res.statusCode).toBe(200);
      // "Jimmy Test (4)" is credited only at TRACK scope on a track of 7000001 — release-only
      // matching used to drop it entirely.
      expect(ids(res.payload)).toContain(7000001);
    });

    it('returns the same release set for an alias and its canonical name', async () => {
      const aliasRes = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/Jimmy%20Test%20(4)',
      });
      const canonicalRes = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/Jimmy%20Test',
      });
      expect(canonicalRes.statusCode).toBe(200);
      expect(ids(canonicalRes.payload).sort()).toEqual(ids(aliasRes.payload).sort());
      expect(ids(canonicalRes.payload)).toContain(7000001);
    });

    it('does NOT expand a group query to its members’ solo work (precision, #330 review)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/The%20Test%20Swampers',
      });
      expect(res.statusCode).toBe(200);
      const got = ids(res.payload);
      // Returns the group's OWN credit (7000001) only — branch 3 (group→members) was dropped so the
      // group is not over-attributed with the members' unrelated solo credits (7000002, 7000003).
      expect(got).toContain(7000001);
      expect(got).not.toContain(7000002);
      expect(got).not.toContain(7000003);
    });

    it('expands a member query to the group’s work (member→group, the kept direction)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/Test%20Hood',
      });
      expect(res.statusCode).toBe(200);
      const got = ids(res.payload);
      expect(got).toContain(7000002); // the member's own credit
      expect(got).toContain(7000001); // the group's credit, via MEMBER_OF (inferred involvement)
    });
  });

  describe('GET /api/v1/explore/tracks/most-international', () => {
    it('ranks a track by the number of distinct origin countries of its credited musicians', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/most-international?limit=5',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        trackTitle: string;
        releaseDiscogsId: number;
        countryCount: number;
        countries: string[];
      }[];
      const maiden = body.find(
        (t) => t.trackTitle === 'Maiden Voyage' && t.releaseDiscogsId === SEED_RELEASE_ID,
      );
      expect(maiden).toBeDefined();
      expect(maiden!.countryCount).toBe(3);
      expect([...maiden!.countries].sort()).toEqual(['FR', 'JP', 'US']);
    });

    it('rejects limit > 50 via schema', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/most-international?limit=999',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/explore/releases/most-pressed', () => {
    it('ranks a master by the number of distinct pressing countries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/releases/most-pressed?limit=5',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as {
        masterDiscogsId: number;
        albumTitle: string;
        countryCount: number;
        countries: string[];
      }[];
      const master = body.find((m) => m.masterDiscogsId === 800001);
      expect(master).toBeDefined();
      expect(master!.albumTitle).toBe('Maiden Voyage');
      expect(master!.countryCount).toBe(3);
      expect([...master!.countries].sort()).toEqual(['Japan', 'UK', 'US']);
    });

    it('rejects limit > 50 via schema', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/releases/most-pressed?limit=999',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/explore/tracks/by-audio-features', () => {
    it('returns the seeded enriched tracks when unfiltered', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { trackTitle: string }[];
      const titles = body.map((t) => t.trackTitle);
      // Only the three seeded tracks carry tempo or deezerBpm, so only they pass
      // the route's base "(tempo IS NOT NULL OR deezerBpm IS NOT NULL)" filter.
      expect(titles).toEqual(
        expect.arrayContaining(['Maiden Voyage', 'The Eye of the Hurricane', 'Little One']),
      );
    });

    it('filters by scale=minor to the expected subset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features?scale=minor',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { trackTitle: string; musicalScale: string }[];
      expect(body.every((t) => t.musicalScale === 'minor')).toBe(true);
      const titles = body.map((t) => t.trackTitle);
      expect(titles).toContain('The Eye of the Hurricane'); // A minor
      expect(titles).not.toContain('Maiden Voyage'); // C major
    });

    it('filters by minTempo across both AcousticBrainz tempo and deezerBpm', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features?minTempo=100',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { trackTitle: string }[];
      const titles = body.map((t) => t.trackTitle);
      expect(titles).toContain('The Eye of the Hurricane'); // tempo 140
      expect(titles).toContain('Little One'); // deezerBpm 120, no AcousticBrainz tempo
      expect(titles).not.toContain('Maiden Voyage'); // tempo 90
    });

    it('rejects an out-of-range minDanceability', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features?minDanceability=2',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an invalid scale enum value', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features?scale=lydian',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // The "six degrees" finder (#343). Ron Carter is CREDITED_ON both 7000001 (Maiden Voyage) and
  // 7000002 (Speak No Evil), and both were RECORDED_AT Van Gelder Studio — two equal-length (2-hop)
  // connectors, so the path goes through a person/studio, never a genre/country hub.
  describe('GET /api/v1/explore/path', () => {
    interface PathStep {
      relationship: string;
      node: { type: string; name: string | null; title: string | null; discogsId: number | null };
    }
    interface PathBody {
      from: { discogsId: number | null } | null;
      to: { discogsId: number | null } | null;
      found: boolean;
      length: number | null;
      maxDepth: number;
      steps: PathStep[];
    }

    it('finds a 2-hop path between two releases via a shared session player or studio', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=7000001&to=7000002',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as PathBody;
      expect(body.found).toBe(true);
      expect(body.length).toBe(2);
      expect(body.steps).toHaveLength(2);
      // The single intermediate node connects the two records — Ron Carter or Van Gelder Studio,
      // never a Genre/Country hub. (shortestPath picks one of the equal-length paths arbitrarily.)
      const middle = body.steps[0]!.node;
      expect(['Musician', 'Studio']).toContain(middle.type);
      expect([middle.name, body.steps[0]!.relationship]).not.toContain('Rock');
      // The path ends at the destination release.
      expect(body.steps[1]!.node.discogsId).toBe(7000002);
    });

    it('resolves a person endpoint by name (1-hop person → release)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=Ron%20Carter&to=7000002',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as PathBody;
      expect(body.found).toBe(true);
      expect(body.length).toBe(1);
      expect(body.steps[0]!.relationship).toBe('CREDITED_ON');
      expect(body.steps[0]!.node.discogsId).toBe(7000002);
    });

    it('returns 404 when an endpoint resolves to no node', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=99999999&to=7000002',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});
