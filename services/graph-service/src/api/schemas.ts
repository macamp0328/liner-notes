import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Shared response schemas
//
// Registered once on the Fastify instance (registerSharedSchemas) and referenced
// from route response schemas via the *Ref objects below, so the error and
// pagination envelopes live in exactly one place — both in source and in the
// generated OpenAPI spec (they surface under components.schemas, keyed by $id).
// ---------------------------------------------------------------------------

export const errorResponseSchema = {
  $id: 'ErrorResponse',
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

export const paginationSchema = {
  $id: 'PaginationMeta',
  type: 'object',
  required: ['page', 'limit', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    total: { type: 'integer', minimum: 0 },
    totalPages: { type: 'integer', minimum: 0 },
  },
} as const;

// Reference objects for use inside route `response` maps and nested `properties`.
// The `Id#` fragment form is how Fastify resolves a schema added via addSchema.
export const errorResponseRef = { $ref: 'ErrorResponse#' } as const;
export const paginationRef = { $ref: 'PaginationMeta#' } as const;

/**
 * Register the shared response schemas on a Fastify instance. Must be called
 * before any route that `$ref`s them is registered (route schema compilation
 * resolves the reference at registration time), so callers invoke this right
 * after building the instance and before registering routes.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema(errorResponseSchema);
  app.addSchema(paginationSchema);
}
