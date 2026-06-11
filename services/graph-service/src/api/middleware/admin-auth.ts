import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Constant-time string comparison. Hashing both sides first fixes the lengths,
 * so timingSafeEqual never throws on length mismatch and the comparison leaks
 * neither length nor prefix information — a plain `!==` short-circuits on the
 * first differing byte, which is a (slow, but real) oracle for guessing the
 * token one character at a time.
 */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Strict authorization predicate: true only when ADMIN_TOKEN is set AND the request
 * carries a matching `Bearer <token>`. Deliberately returns false when the token is
 * unset, so callers (e.g. the rate-limiter allowList) never treat an unconfigured
 * instance as "authorized". The hook below keeps the richer 503-vs-401 distinction.
 */
export function isAuthorizedAdmin(request: FastifyRequest): boolean {
  const token = process.env['ADMIN_TOKEN'];
  if (!token) return false;
  const auth = request.headers['authorization'];
  return typeof auth === 'string' && safeEqual(auth, `Bearer ${token}`);
}

export async function adminAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!process.env['ADMIN_TOKEN']) {
    return reply.code(503).send({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Admin token not configured' },
    });
  }
  if (!isAuthorizedAdmin(request)) {
    return reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Valid ADMIN_TOKEN bearer token required' },
    });
  }
}
