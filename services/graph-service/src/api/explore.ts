import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';
import {
  getReleasesByMusician,
  getReleasesByStudio,
  getReleasesByLabel,
  getReleasesByGenre,
  getReleasesByStyle,
  getReleasesByCountry,
  getReleasesByDecade,
  getReleasesByYear,
  getConnections,
  getSharedMusicians,
  getMostInternationalTracks,
  type ExploreRelease,
  type MusicianRelease,
  type ConnectionNode,
  type SharedMusiciansResult,
  type InternationalTrack,
} from '../db/repositories/explore-repository.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const exploreReleaseSchema = {
  type: 'object',
  required: ['discogsId', 'title'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    artist: { type: 'string', nullable: true },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
  },
} as const;

const musicianReleaseSchema = {
  type: 'object',
  required: ['discogsId', 'title'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    artist: { type: 'string', nullable: true },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    instrument: { type: 'string', nullable: true },
    role: { type: 'string', nullable: true },
  },
} as const;

const connectionNodeSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string' },
    discogsId: { type: 'integer', nullable: true },
    name: { type: 'string', nullable: true },
    title: { type: 'string', nullable: true },
  },
} as const;

const connectionsResponseSchema = {
  type: 'object',
  required: ['seed', 'nodes'],
  properties: {
    seed: exploreReleaseSchema,
    nodes: { type: 'array', items: connectionNodeSchema },
  },
} as const;

const sharedMusiciansResponseSchema = {
  type: 'object',
  required: ['releaseA', 'releaseB', 'sharedMusicians'],
  properties: {
    releaseA: {
      type: 'object',
      required: ['discogsId', 'title'],
      properties: {
        discogsId: { type: 'integer' },
        title: { type: 'string' },
      },
    },
    releaseB: {
      type: 'object',
      required: ['discogsId', 'title'],
      properties: {
        discogsId: { type: 'integer' },
        title: { type: 'string' },
      },
    },
    sharedMusicians: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          instrument: { type: 'string', nullable: true },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface NameParams {
  name: string;
}

interface DecadeParams {
  decade: string;
}

interface YearParams {
  year: number;
}

interface DiscogsIdParams {
  discogsId: number;
}

interface DepthQuery {
  depth?: number;
}

interface ErrorReply {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
export async function exploreRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/explore/musician/:name
  fastify.get<{ Params: NameParams; Reply: MusicianRelease[] | ErrorReply }>(
    '/api/v1/explore/musician/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases featuring this musician, with instrument and role on each result',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: musicianReleaseSchema },
          400: errorSchema,
        },
      },
    },
    async (request, reply): Promise<MusicianRelease[] | ErrorReply> => {
      const items = await getReleasesByMusician(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/studio/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/studio/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases recorded at this studio',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByStudio(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/label/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/label/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases on this label',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByLabel(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/genre/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/genre/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases in this genre',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByGenre(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/style/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/style/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases in this style',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByStyle(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/country/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/country/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases from this country',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByCountry(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/decade/:decade
  fastify.get<{ Params: DecadeParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/decade/:decade',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases from this decade — accepts 1970s format',
        params: {
          type: 'object',
          required: ['decade'],
          properties: { decade: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
          400: errorSchema,
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      if (!/^\d{4}s$/.test(request.params.decade)) {
        return reply.code(400).send({
          error: { code: 'INVALID_DECADE', message: 'decade must be in the format 1970s' },
        });
      }
      const items = await getReleasesByDecade(getDriver(), request.params.decade);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/year/:year
  fastify.get<{ Params: YearParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/year/:year',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases from this exact year',
        params: {
          type: 'object',
          required: ['year'],
          properties: { year: { type: 'integer', minimum: 1000, maximum: 9999 } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByYear(getDriver(), request.params.year);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/connections/:discogsId
  fastify.get<{
    Params: DiscogsIdParams;
    Querystring: DepthQuery;
    Reply: { seed: ExploreRelease; nodes: ConnectionNode[] } | ErrorReply;
  }>(
    '/api/v1/explore/connections/:discogsId',
    {
      schema: {
        tags: ['explore'],
        summary:
          'Graph traversal from a release — returns nodes reachable within depth hops (max 3)',
        params: {
          type: 'object',
          required: ['discogsId'],
          properties: { discogsId: { type: 'integer' } },
        },
        querystring: {
          type: 'object',
          properties: {
            depth: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
          },
        },
        response: {
          200: connectionsResponseSchema,
          404: errorSchema,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<{ seed: ExploreRelease; nodes: ConnectionNode[] } | ErrorReply> => {
      const depth = request.query.depth ?? 2;
      const graph = await getConnections(getDriver(), request.params.discogsId, depth as 1 | 2 | 3);
      if (!graph) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Release not found' },
        });
      }
      return reply.send(graph);
    },
  );

  // GET /api/v1/explore/shared-musicians
  fastify.get<{ Reply: SharedMusiciansResult[] }>(
    '/api/v1/explore/shared-musicians',
    {
      schema: {
        tags: ['explore'],
        summary: 'Release pairs that share one or more session musicians',
        response: {
          200: { type: 'array', items: sharedMusiciansResponseSchema },
        },
      },
    },
    async (_request, reply): Promise<SharedMusiciansResult[]> => {
      const pairs = await getSharedMusicians(getDriver());
      return reply.send(pairs);
    },
  );

  // GET /api/v1/explore/tracks/most-international
  fastify.get<{
    Querystring: { limit?: number };
    Reply: InternationalTrack[] | ErrorReply;
  }>(
    '/api/v1/explore/tracks/most-international',
    {
      schema: {
        tags: ['explore'],
        summary:
          'Tracks with the most distinct countries of origin among their credited musicians. Requires nationality enrichment to have been run.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              required: ['trackTitle', 'albumTitle', 'releaseDiscogsId', 'countryCount', 'countries'],
              properties: {
                trackTitle: { type: 'string' },
                albumTitle: { type: 'string' },
                releaseDiscogsId: { type: 'integer' },
                countryCount: { type: 'integer' },
                countries: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (request, reply): Promise<InternationalTrack[] | ErrorReply> => {
      const limit = request.query.limit ?? 10;
      const results = await getMostInternationalTracks(getDriver(), limit);
      return reply.send(results);
    },
  );
}
