import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestServer } from '../setup.js';
import {
  seedGraph,
  clearGraph,
  seedExploreEnrichment,
  seedEntityResolution,
} from '../../fixtures/loader.js';
import { getDriver } from '../../../src/db/client.js';

const SEED_RELEASE_ID = 7000001; // Maiden Voyage — Herbie Hancock, Blue Note, US, 1966

describe('explore routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer();
    await clearGraph(getDriver());
    await seedGraph(getDriver());
    await seedExploreEnrichment(getDriver());
    await seedEntityResolution(getDriver());
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

    it('expands a group query to its members’ work (≥2 members resolved)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/The%20Test%20Swampers',
      });
      expect(res.statusCode).toBe(200);
      const got = ids(res.payload);
      // The group's own credit (7000001) plus both members' releases (7000002, 7000003).
      expect(got).toContain(7000001);
      expect(got).toContain(7000002);
      expect(got).toContain(7000003);
    });

    it('expands a member query to the group’s work (vice-versa)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/Test%20Hood',
      });
      expect(res.statusCode).toBe(200);
      const got = ids(res.payload);
      expect(got).toContain(7000002); // the member's own credit
      expect(got).toContain(7000001); // the group's credit, via MEMBER_OF
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
});
