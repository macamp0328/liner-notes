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

export async function adminAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = process.env['ADMIN_TOKEN'];
  if (!token) {
    return reply.code(503).send({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Admin token not configured' },
    });
  }
  const auth = request.headers['authorization'];
  if (!auth || !safeEqual(auth, `Bearer ${token}`)) {
    return reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Valid ADMIN_TOKEN bearer token required' },
    });
  }
}
