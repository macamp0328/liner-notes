import type { FastifyRequest, FastifyReply } from 'fastify';

export async function adminAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = process.env['ADMIN_TOKEN'];
  if (!token) {
    return reply.code(503).send({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Admin token not configured' },
    });
  }
  const auth = request.headers['authorization'];
  if (!auth || auth !== `Bearer ${token}`) {
    return reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Valid ADMIN_TOKEN bearer token required' },
    });
  }
}
