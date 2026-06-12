import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Global error + not-found handlers (issue #288)
//
// Without these, framework-generated errors bypass the documented
// `{ error: { code, message } }` envelope (see schemas.ts / CLAUDE.md
// "Response Shapes"): Fastify's default handler serialises raw `err.message`
// into 500 bodies — leaking Neo4j/Aura connection and Cypher details to
// anonymous callers — and emits `{ statusCode, error, message }` for validation
// 400s, unknown-route 404s, and rate-limit 429s. The not-found handler also
// runs the rate limiter as a preHandler so unmatched paths are metered (global
// `@fastify/rate-limit` only attaches to registered routes).
//
// Hand-rolled route errors use `reply.code(n).send(...)` and *return* (never
// throw), so they bypass the error handler entirely and keep their own envelope.
// ---------------------------------------------------------------------------

/**
 * Map a client error (4xx) reaching the error handler to an envelope `code`.
 * Pure and exported for direct unit testing. The only 4xx that organically
 * reach the handler are schema-validation 400s (`error.validation` set) and
 * rate-limit 429s; `CLIENT_ERROR` is the defensive fallback for any other 4xx.
 */
export function clientErrorCode(error: FastifyError, status: number): string {
  if (error.validation) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  return 'CLIENT_ERROR';
}

/**
 * Install the global error and not-found handlers on a Fastify instance.
 *
 * Ordering is load-bearing — call this:
 *   - AFTER `@fastify/rate-limit` is registered, because the not-found handler's
 *     `preHandler` uses `app.rateLimit()`; and
 *   - BEFORE the route plugins, because `setErrorHandler` is encapsulated: each
 *     route plugin is a child context that inherits the error handler at
 *     registration time, so a handler set afterwards would not apply to routes
 *     already registered. (`setNotFoundHandler` resolves at the root and is
 *     order-insensitive, but both are installed together here.)
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  // Non-async on purpose: an async handler with no `await` trips
  // @typescript-eslint/require-await.
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => {
    const status = error.statusCode ?? 500;

    // 5xx (or no status): log the full error server-side, return a generic body.
    // This is the leak fix — `error.message` never reaches the response.
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      void reply
        .code(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' } });
      return;
    }

    // 4xx: re-wrap in the envelope, preserving status. The message describes the
    // caller's own malformed request (validation detail, rate-limit retry hint)
    // and is safe to surface.
    void reply
      .code(status)
      .send({ error: { code: clientErrorCode(error, status), message: error.message } });
  });

  app.setNotFoundHandler(
    { preHandler: app.rateLimit() },
    (_request: FastifyRequest, reply: FastifyReply): void => {
      void reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    },
  );
}
