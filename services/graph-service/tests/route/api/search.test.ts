import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Neo4jError } from 'neo4j-driver';
import { buildServer } from '../../../src/server.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSearchGeneral = vi.hoisted(() => vi.fn());
const mockSearchLyrics = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/job-repository.js', () => ({
  findResumableReloadJob: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repositories/search-repository.js', () => ({
  searchGeneral: mockSearchGeneral,
  searchLyrics: mockSearchLyrics,
}));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const sampleArtistResult = {
  type: 'Artist' as const,
  name: 'John Coltrane',
  discogsId: 98765,
  score: 3.14,
};

const sampleReleaseResult = {
  type: 'Release' as const,
  title: 'A Love Supreme',
  discogsId: 12345,
  artist: 'John Coltrane',
  score: 2.71,
};

const sampleTrackResult = {
  type: 'Track' as const,
  title: 'Acknowledgement',
  releaseTitle: 'A Love Supreme',
  releaseDiscogsId: 12345,
  score: 1.62,
};

const sampleLyricsResult = {
  trackTitle: 'Acknowledgement',
  releaseTitle: 'A Love Supreme',
  releaseDiscogsId: 12345,
  score: 4.2,
};

// A real Neo4jError as the fulltext procedure surfaces a Lucene parse failure. Built via
// Object.create so the test does not depend on the driver's constructor arity.
function makeLuceneParseError(): Neo4jError {
  const err = Object.create(Neo4jError.prototype) as Neo4jError;
  return Object.assign(err, {
    name: 'Neo4jError',
    message:
      'Failed to invoke procedure `db.index.fulltext.queryNodes`: Caused by: ' +
      'org.apache.lucene.queryparser.classic.ParseException: Cannot parse',
    code: 'Neo.ClientError.Procedure.ProcedureCallFailed',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('search routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // GET /api/v1/search?q=
  describe('GET /api/v1/search', () => {
    it('returns 200 with mixed results ranked by score', async () => {
      mockSearchGeneral.mockResolvedValue([
        sampleArtistResult,
        sampleReleaseResult,
        sampleTrackResult,
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/search?q=coltrane',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleArtistResult)[];
      expect(body).toHaveLength(3);
      expect(body[0]!.type).toBe('Artist');
      expect(body[1]!.type).toBe('Release');
      expect(body[2]!.type).toBe('Track');
    });

    it('returns 200 with empty array when no results', async () => {
      mockSearchGeneral.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/search?q=xyznoexist',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });

    it('returns 400 when q is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/search' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('MISSING_QUERY');
      expect(body.error.message).toBe('q is required and must not be empty');
    });

    it('returns 400 when q is empty string', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('MISSING_QUERY');
    });

    it('returns 400 when q is whitespace only', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=%20%20%20' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('MISSING_QUERY');
    });

    it('returns 400 when q exceeds 500 characters', async () => {
      const longQ = 'a'.repeat(501);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/search?q=${longQ}`,
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('QUERY_TOO_LONG');
      expect(body.error.message).toBe('q must be 500 characters or fewer');
    });

    it('accepts q of exactly 500 characters', async () => {
      mockSearchGeneral.mockResolvedValue([]);
      const exactQ = 'a'.repeat(500);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/search?q=${exactQ}`,
      });
      expect(response.statusCode).toBe(200);
    });

    it('returns 400 INVALID_QUERY when Neo4j reports a Lucene parse error', async () => {
      mockSearchGeneral.mockRejectedValue(makeLuceneParseError());
      const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=%28' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INVALID_QUERY');
    });

    it('rethrows a non-parse error as a 500', async () => {
      mockSearchGeneral.mockRejectedValue(new Error('connection reset'));
      const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=coltrane' });
      expect(response.statusCode).toBe(500);
    });
  });

  // GET /api/v1/search/lyrics?q=
  describe('GET /api/v1/search/lyrics', () => {
    it('returns 200 with lyric results including release context', async () => {
      mockSearchLyrics.mockResolvedValue([sampleLyricsResult]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/search/lyrics?q=supreme',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleLyricsResult)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.trackTitle).toBe('Acknowledgement');
      expect(body[0]!.releaseTitle).toBe('A Love Supreme');
      expect(body[0]!.score).toBe(4.2);
    });

    it('returns 200 with empty array when no results', async () => {
      mockSearchLyrics.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/search/lyrics?q=xyznoexist',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });

    it('returns 400 when q is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/search/lyrics' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('MISSING_QUERY');
    });

    it('returns 400 when q is empty string', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/search/lyrics?q=' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('MISSING_QUERY');
    });

    it('returns 400 when q is whitespace only', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/search/lyrics?q=%20%20',
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('MISSING_QUERY');
    });

    it('returns 400 when q exceeds 500 characters', async () => {
      const longQ = 'b'.repeat(501);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/search/lyrics?q=${longQ}`,
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('QUERY_TOO_LONG');
    });

    it('returns 400 INVALID_QUERY when Neo4j reports a Lucene parse error', async () => {
      mockSearchLyrics.mockRejectedValue(makeLuceneParseError());
      const response = await app.inject({ method: 'GET', url: '/api/v1/search/lyrics?q=%22' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_QUERY');
    });

    it('rethrows a non-parse error as a 500', async () => {
      mockSearchLyrics.mockRejectedValue(new Error('connection reset'));
      const response = await app.inject({ method: 'GET', url: '/api/v1/search/lyrics?q=supreme' });
      expect(response.statusCode).toBe(500);
    });
  });
});
