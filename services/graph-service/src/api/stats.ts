import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';
import { getStats, type StatsData } from '../db/stats-repository.js';
import { isReloadActive } from '../ingestion/reload-progress.js';

interface StatsReply {
  data: StatsData;
}

// Public endpoint — Cypher count scans are cheap for this collection size, but a
// short cache keeps repeated unauthenticated hits (a dashboard widget, an external
// monitor) from re-scanning the graph every request. Scoped per Fastify instance
// (declared inside the plugin) so each built server — including each test app —
// starts with a clean cache.
const CACHE_TTL_MS = 60_000;

// While an orchestrated reload is running, coverage moves fast and an operator is watching it.
// Drop to a short TTL so /stats is near-real-time, but not 0 — the in-flight coalescing plus a
// few-second window still shield the graph from a per-request scan storm during the reload.
const ACTIVE_CACHE_TTL_MS = 5_000;

const coverageSchema = {
  type: 'object',
  required: ['covered', 'applicable', 'pct'],
  properties: {
    covered: { type: 'integer' },
    applicable: { type: 'integer' },
    pct: { type: 'number', nullable: true },
  },
} as const;

// A multi-source stage: the parent coverage plus a per-source split. `sources`
// keys vary by stage (lyrics → lrclib/genius/untagged; nationality →
// musicbrainz/wikidata/untagged), so it's an open map of CoverageMetric.
const sourcedCoverageSchema = {
  type: 'object',
  required: ['covered', 'applicable', 'pct', 'sources'],
  properties: {
    covered: { type: 'integer' },
    applicable: { type: 'integer' },
    pct: { type: 'number', nullable: true },
    sources: { type: 'object', additionalProperties: coverageSchema },
  },
} as const;

// The five-state lyrics funnel (#246, #248): the buckets partition `total` exactly.
const lyricsFunnelSchema = {
  type: 'object',
  required: [
    'resolved',
    'instrumental',
    'probableInstrumental',
    'lowConfidence',
    'notFound',
    'total',
  ],
  properties: {
    resolved: { type: 'integer' },
    instrumental: { type: 'integer' },
    probableInstrumental: { type: 'integer' },
    lowConfidence: { type: 'integer' },
    notFound: { type: 'integer' },
    total: { type: 'integer' },
  },
} as const;

// eslint-disable-next-line @typescript-eslint/require-await
export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  let cache: { at: number; data: StatsData } | null = null;
  // Coalesce concurrent refreshes: on a cold/expired cache, many simultaneous
  // requests would each run getStats() (four full-label scans). Sharing one
  // in-flight promise collapses them into a single refresh.
  let inFlight: Promise<StatsData> | null = null;

  fastify.get<{ Reply: StatsReply }>(
    '/api/v1/stats',
    {
      schema: {
        tags: ['ops'],
        summary: 'Public graph + enrichment coverage stats',
        description:
          'Unauthenticated node counts and per-enrichment coverage (covered/applicable/pct). ' +
          'Cached for 60s, shortened to ~5s while an orchestrated reload is running so coverage ' +
          'is near-real-time. Leaks only collection size — all underlying data is already public.',
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['counts', 'enrichment'],
                properties: {
                  counts: {
                    type: 'object',
                    required: ['releases', 'artists', 'tracks', 'masters', 'musicians'],
                    properties: {
                      releases: { type: 'integer' },
                      artists: { type: 'integer' },
                      tracks: { type: 'integer' },
                      masters: { type: 'integer' },
                      musicians: { type: 'integer' },
                    },
                  },
                  enrichment: {
                    type: 'object',
                    required: [
                      'releasesWithOriginalYear',
                      'artistsWithProfile',
                      'artistsWithGenres',
                      'artistsWithStyles',
                      'artistsWithNationality',
                      'musiciansWithNationality',
                      'producersWithNationality',
                      'engineersWithNationality',
                      'tracksWithLyrics',
                      'lyricsFunnel',
                      'tracksWithRecordingMbid',
                      'tracksWithIsrc',
                      'tracksWithTempo',
                      'tracksWithDeezerBpm',
                      'tracksWithDeezerGain',
                      'mastersWithReleaseEvents',
                      'samePersonLinks',
                      'memberOfEdges',
                      'groupsWithMembers',
                    ],
                    properties: {
                      releasesWithOriginalYear: coverageSchema,
                      artistsWithProfile: coverageSchema,
                      artistsWithGenres: coverageSchema,
                      artistsWithStyles: coverageSchema,
                      artistsWithNationality: sourcedCoverageSchema,
                      musiciansWithNationality: sourcedCoverageSchema,
                      producersWithNationality: sourcedCoverageSchema,
                      engineersWithNationality: sourcedCoverageSchema,
                      tracksWithLyrics: sourcedCoverageSchema,
                      lyricsFunnel: lyricsFunnelSchema,
                      tracksWithRecordingMbid: coverageSchema,
                      tracksWithIsrc: coverageSchema,
                      tracksWithTempo: coverageSchema,
                      tracksWithDeezerBpm: coverageSchema,
                      tracksWithDeezerGain: coverageSchema,
                      mastersWithReleaseEvents: coverageSchema,
                      samePersonLinks: coverageSchema,
                      memberOfEdges: { type: 'integer' },
                      groupsWithMembers: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (): Promise<StatsReply> => {
      const now = Date.now();
      const ttl = isReloadActive() ? ACTIVE_CACHE_TTL_MS : CACHE_TTL_MS;
      if (cache && now - cache.at <= ttl) {
        return { data: cache.data };
      }
      // Cache miss or expiry — start a refresh if none is running, then await
      // whichever refresh is in flight so concurrent callers share one query.
      if (!inFlight) {
        inFlight = getStats(getDriver())
          .then((data) => {
            cache = { at: Date.now(), data };
            return data;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return { data: await inFlight };
    },
  );
}
