import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { adminAuthHook } from '../../../src/api/middleware/admin-auth.js';

function makeReply() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
  return reply;
}

function makeRequest(authHeader?: string): FastifyRequest {
  return {
    headers: { authorization: authHeader },
  } as unknown as FastifyRequest;
}

describe('adminAuthHook', () => {
  const originalToken = process.env['ADMIN_TOKEN'];

  beforeEach(() => {
    process.env['ADMIN_TOKEN'] = 'secret-token';
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env['ADMIN_TOKEN'];
    } else {
      process.env['ADMIN_TOKEN'] = originalToken;
    }
  });

  it('passes through when token is valid', async () => {
    const request = makeRequest('Bearer secret-token');
    const reply = makeReply();
    await adminAuthHook(request, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const request = makeRequest(undefined);
    const reply = makeReply();
    await adminAuthHook(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'UNAUTHORIZED' }) }),
    );
  });

  it('returns 401 when token is wrong', async () => {
    const request = makeRequest('Bearer wrong-token');
    const reply = makeReply();
    await adminAuthHook(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'UNAUTHORIZED' }) }),
    );
  });

  it('returns 401 when using wrong scheme', async () => {
    const request = makeRequest('Basic secret-token');
    const reply = makeReply();
    await adminAuthHook(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('returns 503 when ADMIN_TOKEN env var is not set', async () => {
    delete process.env['ADMIN_TOKEN'];
    const request = makeRequest('Bearer anything');
    const reply = makeReply();
    await adminAuthHook(request, reply);
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }) }),
    );
  });
});
