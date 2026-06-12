import { FastifyInstance, FastifyReply } from 'fastify';
import { Neo4jError } from 'neo4j-driver';
import { getDriver } from '../db/client.js';
import {
  searchGeneral,
  searchLyrics,
  type SearchResultItem,
  type LyricsSearchResult,
} from '../db/repositories/search-repository.js';
import { errorResponseRef } from './schemas.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

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

// A malformed Lucene query reaches Neo4j as a procedure-call failure wrapping a Lucene
// ParseException. Match it narrowly so genuinely different client errors (missing index, missing
// parameter) still surface as 500 rather than being mislabelled a client 400. In practice
// escapeLuceneQuery prevents the parse error entirely; this is a backstop.
function isLuceneParseError(err: unknown): err is Neo4jError {
  return (
    err instanceof Neo4jError &&
    err.code === 'Neo.ClientError.Procedure.ProcedureCallFailed' &&
    /ParseException|Cannot parse|lucene/i.test(err.message)
  );
}

async function runSearch<T>(
  reply: FastifyReply,
  exec: () => Promise<T[]>,
): Promise<T[] | ErrorReply> {
  try {
    return await exec();
  } catch (err) {
    if (isLuceneParseError(err)) {
      void reply.code(400);
      return {
        error: { code: 'INVALID_QUERY', message: 'q could not be parsed as a search query' },
      };
    }
    throw err;
  }
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
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<SearchResultItem[] | ErrorReply> => {
      const validated = validateQ(request.query.q);
      if (typeof validated !== 'string') {
        return reply.code(400).send(validated);
      }
      return runSearch(reply, () => searchGeneral(getDriver(), validated));
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
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<LyricsSearchResult[] | ErrorReply> => {
      const validated = validateQ(request.query.q);
      if (typeof validated !== 'string') {
        return reply.code(400).send(validated);
      }
      return runSearch(reply, () => searchLyrics(getDriver(), validated));
    },
  );
}
