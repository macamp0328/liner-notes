import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';
import {
  searchGeneral,
  searchLyrics,
  type SearchResultItem,
  type LyricsSearchResult,
} from '../db/repositories/search-repository.js';

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

// Discriminated union represented as anyOf in OpenAPI
const searchResultItemSchema = {
  anyOf: [
    {
      type: 'object',
      required: ['type', 'name', 'discogsId', 'score'],
      properties: {
        type: { type: 'string', enum: ['Artist'] },
        name: { type: 'string' },
        discogsId: { type: 'integer' },
        score: { type: 'number' },
      },
    },
    {
      type: 'object',
      required: ['type', 'title', 'discogsId', 'score'],
      properties: {
        type: { type: 'string', enum: ['Release'] },
        title: { type: 'string' },
        discogsId: { type: 'integer' },
        artist: { type: 'string', nullable: true },
        score: { type: 'number' },
      },
    },
    {
      type: 'object',
      required: ['type', 'title', 'score'],
      properties: {
        type: { type: 'string', enum: ['Track'] },
        title: { type: 'string' },
        releaseTitle: { type: 'string', nullable: true },
        releaseDiscogsId: { type: 'integer', nullable: true },
        score: { type: 'number' },
      },
    },
  ],
} as const;

const lyricsResultSchema = {
  type: 'object',
  required: ['trackTitle', 'score'],
  properties: {
    trackTitle: { type: 'string' },
    releaseTitle: { type: 'string', nullable: true },
    releaseDiscogsId: { type: 'integer', nullable: true },
    score: { type: 'number' },
  },
} as const;

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface SearchQuery {
  q?: string;
}

interface ErrorReply {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateQ(q: string | undefined): string | ErrorReply {
  if (!q || q.trim().length === 0) {
    return { error: { code: 'MISSING_QUERY', message: 'q is required and must not be empty' } };
  }
  if (q.length > 500) {
    return { error: { code: 'QUERY_TOO_LONG', message: 'q must be 500 characters or fewer' } };
  }
  return q;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/search?q=
  fastify.get<{ Querystring: SearchQuery; Reply: SearchResultItem[] | ErrorReply }>(
    '/api/v1/search',
    {
      schema: {
        tags: ['search'],
        summary: 'Full-text search across releases, artists, and tracks — ranked by relevance',
        querystring: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: searchResultItemSchema },
          400: errorSchema,
        },
      },
    },
    async (request, reply): Promise<SearchResultItem[] | ErrorReply> => {
      const validated = validateQ(request.query.q);
      if (typeof validated !== 'string') {
        return reply.code(400).send(validated);
      }
      const results = await searchGeneral(getDriver(), validated);
      return reply.send(results);
    },
  );

  // GET /api/v1/search/lyrics?q=
  fastify.get<{ Querystring: SearchQuery; Reply: LyricsSearchResult[] | ErrorReply }>(
    '/api/v1/search/lyrics',
    {
      schema: {
        tags: ['search'],
        summary: 'Full-text search within track lyrics — returns tracks with release context',
        querystring: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: lyricsResultSchema },
          400: errorSchema,
        },
      },
    },
    async (request, reply): Promise<LyricsSearchResult[] | ErrorReply> => {
      const validated = validateQ(request.query.q);
      if (typeof validated !== 'string') {
        return reply.code(400).send(validated);
      }
      const results = await searchLyrics(getDriver(), validated);
      return reply.send(results);
    },
  );
}
