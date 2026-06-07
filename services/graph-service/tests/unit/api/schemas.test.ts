import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerSharedSchemas,
  errorResponseRef,
  paginationRef,
} from '../../../src/api/schemas.js';

describe('registerSharedSchemas', () => {
  it('registers ErrorResponse and PaginationMeta as retrievable shared schemas', () => {
    const app = Fastify({ logger: false });
    registerSharedSchemas(app);

    const error = app.getSchema('ErrorResponse') as Record<string, unknown>;
    expect(error).toMatchObject({
      $id: 'ErrorResponse',
      required: ['error'],
    });

    const pagination = app.getSchema('PaginationMeta') as Record<string, unknown>;
    expect(pagination).toMatchObject({
      $id: 'PaginationMeta',
      required: ['page', 'limit', 'total', 'totalPages'],
    });
  });

  it('lets a route $ref the shared schemas and serialize the referenced shape', async () => {
    const app = Fastify({ logger: false });
    registerSharedSchemas(app);

    // Registration throws if the $ref cannot resolve, so this also guards that
    // the refs stay in sync with the registered $ids.
    app.get('/boom', { schema: { response: { 400: errorResponseRef } } }, async (_req, reply) => {
      void reply.code(400);
      // Extra field is dropped by the response serializer, proving the $ref'd
      // schema (not a passthrough) drives serialization.
      return { error: { code: 'BAD', message: 'nope', secret: 'stripped' } };
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: { code: 'BAD', message: 'nope' } });

    await app.close();
  });

  it('exposes paginationRef pointing at the shared $id', () => {
    expect(errorResponseRef).toEqual({ $ref: 'ErrorResponse#' });
    expect(paginationRef).toEqual({ $ref: 'PaginationMeta#' });
  });
});

describe('OpenAPI spec wiring', () => {
  let app: FastifyInstance;

  it('bundles ErrorResponse + PaginationMeta into components.schemas and $refs them from paths', async () => {
    const { buildDocsServer } = await import('../../../src/server.js');
    app = await buildDocsServer();
    await app.ready();

    const spec = app.swagger() as {
      components?: { schemas?: Record<string, unknown> };
      paths: Record<string, unknown>;
    };

    expect(spec.components?.schemas).toHaveProperty('ErrorResponse');
    expect(spec.components?.schemas).toHaveProperty('PaginationMeta');

    const serialized = JSON.stringify(spec);
    expect(serialized).toContain('#/components/schemas/ErrorResponse');
    expect(serialized).toContain('#/components/schemas/PaginationMeta');

    await app.close();
  });
});
