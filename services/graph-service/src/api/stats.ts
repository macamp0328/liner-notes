import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';
import { getStats, type StatsData } from '../db/stats-repository.js';

interface StatsReply {
  data: StatsData;
}

// Public endpoint — Cypher count scans are cheap for this collection size, but a
// short cache keeps repeated unauthenticated hits (a dashboard widget, an external
// monitor) from re-scanning the graph every request. Scoped per Fastify instance
// (declared inside the plugin) so each built server — including each test app —
// starts with a clean cache.
const CACHE_TTL_MS = 60_000;

const coverageSchema = {
  type: 'object',
  required: ['covered', 'applicable', 'pct'],
  properties: {
    covered: { type: 'integer' },
    applicable: { type: 'integer' },
    pct: { type: 'number', nullable: true },
  },
} as const;

// eslint-disable-next-line @typescript-eslint/require-await
export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  let cache: { at: number; data: StatsData } | null = null;

  fastify.get<{ Reply: StatsReply }>(
    '/api/v1/stats',
    {
      schema: {
        tags: ['ops'],
        summary: 'Public graph + enrichment coverage stats',
        description:
          'Unauthenticated node counts and per-enrichment coverage (covered/applicable/pct). ' +
          'Cached for 60s. Leaks only collection size — all underlying data is already public.',
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
                    required: ['releases', 'artists', 'tracks', 'masters'],
                    properties: {
                      releases: { type: 'integer' },
                      artists: { type: 'integer' },
                      tracks: { type: 'integer' },
                      masters: { type: 'integer' },
                    },
                  },
                  enrichment: {
                    type: 'object',
                    required: [
                      'releasesWithOriginalYear',
                      'artistsWithProfile',
                      'tracksWithLyrics',
                      'tracksWithRecordingMbid',
                      'tracksWithIsrc',
                      'tracksWithTempo',
                      'tracksWithDeezerBpm',
                    ],
                    properties: {
                      releasesWithOriginalYear: coverageSchema,
                      artistsWithProfile: coverageSchema,
                      tracksWithLyrics: coverageSchema,
                      tracksWithRecordingMbid: coverageSchema,
                      tracksWithIsrc: coverageSchema,
                      tracksWithTempo: coverageSchema,
                      tracksWithDeezerBpm: coverageSchema,
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
      if (!cache || now - cache.at > CACHE_TTL_MS) {
        cache = { at: now, data: await getStats(getDriver()) };
      }
      return { data: cache.data };
    },
  );
}
