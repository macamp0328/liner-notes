import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';
import {
  listReleases,
  getReleaseById,
  getArtistById,
  getLabelById,
  type ReleaseListItem,
  type ReleaseFull,
  type ArtistFull,
  type LabelFull,
} from '../db/repositories/collection-repository.js';
import { errorResponseRef, paginationRef } from './schemas.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const releaseListItemSchema = {
  type: 'object',
  required: ['discogsId', 'title'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    artistName: { type: 'string', nullable: true },
    labelName: { type: 'string', nullable: true },
  },
} as const;

const trackSchema = {
  type: 'object',
  required: ['position', 'title', 'musicians'],
  properties: {
    position: { type: 'string' },
    title: { type: 'string' },
    duration: { type: 'string', nullable: true },
    lyrics: { type: 'string', nullable: true },
    lyricsSource: { type: 'string', nullable: true },
    musicians: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'role', 'displayRole'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          displayRole: { type: 'string' },
          creditedAs: { type: 'string', nullable: true },
        },
      },
    },
    tempo: { type: 'number', nullable: true },
    musicalKey: { type: 'string', nullable: true },
    musicalScale: { type: 'string', nullable: true },
    loudnessDb: { type: 'number', nullable: true },
    danceabilityEstimate: { type: 'number', nullable: true },
    voiceInstrumental: { type: 'string', nullable: true },
    deezerBpm: { type: 'number', nullable: true },
    deezerGain: { type: 'number', nullable: true },
  },
} as const;

const releaseFullSchema = {
  type: 'object',
  required: [
    'discogsId',
    'title',
    'artists',
    'labels',
    'genres',
    'styles',
    'studios',
    'tracks',
    'credits',
  ],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    artistName: { type: 'string', nullable: true },
    labelName: { type: 'string', nullable: true },
    masterDiscogsId: { type: 'integer', nullable: true },
    originalYear: { type: 'integer', nullable: true },
    releaseDate: { type: 'string', nullable: true },
    notes: { type: 'string', nullable: true },
    discogsUrl: { type: 'string', nullable: true },
    communityRating: { type: 'number', nullable: true },
    communityRatingCount: { type: 'integer', nullable: true },
    barcode: { type: 'string', nullable: true },
    artists: {
      type: 'array',
      items: {
        type: 'object',
        required: ['discogsId', 'name', 'role'],
        properties: {
          discogsId: { type: 'integer' },
          name: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['discogsId', 'name', 'catalogNumber'],
        properties: {
          discogsId: { type: 'integer' },
          name: { type: 'string' },
          catalogNumber: { type: 'string' },
        },
      },
    },
    genres: { type: 'array', items: { type: 'string' } },
    styles: { type: 'array', items: { type: 'string' } },
    country: { type: 'string', nullable: true },
    studios: { type: 'array', items: { type: 'string' } },
    tracks: { type: 'array', items: trackSchema },
    credits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'role', 'displayRole'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          displayRole: { type: 'string' },
          creditedAs: { type: 'string', nullable: true },
        },
      },
    },
  },
} as const;

const artistReleaseSchema = {
  type: 'object',
  required: ['discogsId', 'title', 'role'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    role: { type: 'string' },
  },
} as const;

const artistCreditSchema = {
  type: 'object',
  required: ['releaseDiscogsId', 'releaseTitle', 'role', 'displayRole', 'scope'],
  properties: {
    releaseDiscogsId: { type: 'integer' },
    releaseTitle: { type: 'string' },
    role: { type: 'string' },
    displayRole: { type: 'string' },
    creditedAs: { type: 'string', nullable: true },
    scope: { type: 'string' },
  },
} as const;

const artistFullSchema = {
  type: 'object',
  required: ['discogsId', 'name', 'releases', 'credits'],
  properties: {
    discogsId: { type: 'integer' },
    name: { type: 'string' },
    realName: { type: 'string', nullable: true },
    profile: { type: 'string', nullable: true },
    // Wikidata-sourced biographical data (#341); null until the artist-wikidata enrichment resolves it.
    wikidataQid: { type: 'string', nullable: true },
    bornYear: { type: 'integer', nullable: true },
    bornDate: { type: 'string', nullable: true },
    diedYear: { type: 'integer', nullable: true },
    diedDate: { type: 'string', nullable: true },
    imageUrl: { type: 'string', nullable: true },
    awards: { type: 'array', items: { type: 'string' } },
    // Person-level instruments from Wikidata P1303 (#393): normalized #333 families + raw labels.
    playsInstrument: { type: 'array', items: { type: 'string' } },
    playsInstrumentRaw: { type: 'array', items: { type: 'string' } },
    releases: { type: 'array', items: artistReleaseSchema },
    credits: { type: 'array', items: artistCreditSchema },
  },
} as const;

const labelReleaseSchema = {
  type: 'object',
  required: ['discogsId', 'title', 'catalogNumber'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    catalogNumber: { type: 'string' },
    artistName: { type: 'string', nullable: true },
  },
} as const;

const labelFullSchema = {
  type: 'object',
  required: ['discogsId', 'name', 'releases'],
  properties: {
    discogsId: { type: 'integer' },
    name: { type: 'string' },
    profile: { type: 'string', nullable: true },
    contactInfo: { type: 'string', nullable: true },
    releases: { type: 'array', items: labelReleaseSchema },
  },
} as const;

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface ReleasesQuery {
  page?: number;
  limit?: number;
}

interface DiscogsIdParams {
  discogsId: number;
}

interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ListReleasesReply {
  data: ReleaseListItem[];
  pagination: PaginationResult;
}

interface SingleReleaseReply {
  data: ReleaseFull;
}

interface SingleArtistReply {
  data: ArtistFull;
}

interface SingleLabelReply {
  data: LabelFull;
}

interface ErrorReply {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
export async function collectionRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/releases
  fastify.get<{ Querystring: ReleasesQuery; Reply: ListReleasesReply }>(
    '/api/v1/releases',
    {
      schema: {
        tags: ['collection'],
        summary: 'Paginated list of all releases in the collection',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data', 'pagination'],
            properties: {
              data: { type: 'array', items: releaseListItemSchema },
              pagination: paginationRef,
            },
          },
        },
      },
    },
    async (request, reply): Promise<ListReleasesReply> => {
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const skip = (page - 1) * limit;
      const { items, total } = await listReleases(getDriver(), skip, limit);
      const totalPages = Math.ceil(total / limit) || 0;
      return reply.send({ data: items, pagination: { page, limit, total, totalPages } });
    },
  );

  // GET /api/v1/releases/:discogsId
  fastify.get<{ Params: DiscogsIdParams; Reply: SingleReleaseReply | ErrorReply }>(
    '/api/v1/releases/:discogsId',
    {
      schema: {
        tags: ['collection'],
        summary: 'Single release with all related nodes hydrated',
        params: {
          type: 'object',
          required: ['discogsId'],
          properties: {
            discogsId: { type: 'integer' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: releaseFullSchema },
          },
          404: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<SingleReleaseReply | ErrorReply> => {
      const release = await getReleaseById(getDriver(), request.params.discogsId);
      if (!release) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Release not found' } });
      }
      return reply.send({ data: release });
    },
  );

  // GET /api/v1/artists/:discogsId
  fastify.get<{ Params: DiscogsIdParams; Reply: SingleArtistReply | ErrorReply }>(
    '/api/v1/artists/:discogsId',
    {
      schema: {
        tags: ['collection'],
        summary: 'Artist with connected releases and credits',
        params: {
          type: 'object',
          required: ['discogsId'],
          properties: {
            discogsId: { type: 'integer' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: artistFullSchema },
          },
          404: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<SingleArtistReply | ErrorReply> => {
      const artist = await getArtistById(getDriver(), request.params.discogsId);
      if (!artist) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Artist not found' } });
      }
      return reply.send({ data: artist });
    },
  );

  // GET /api/v1/labels/:discogsId
  fastify.get<{ Params: DiscogsIdParams; Reply: SingleLabelReply | ErrorReply }>(
    '/api/v1/labels/:discogsId',
    {
      schema: {
        tags: ['collection'],
        summary: 'Label with all releases',
        params: {
          type: 'object',
          required: ['discogsId'],
          properties: {
            discogsId: { type: 'integer' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: { data: labelFullSchema },
          },
          404: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<SingleLabelReply | ErrorReply> => {
      const label = await getLabelById(getDriver(), request.params.discogsId);
      if (!label) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Label not found' } });
      }
      return reply.send({ data: label });
    },
  );
}
