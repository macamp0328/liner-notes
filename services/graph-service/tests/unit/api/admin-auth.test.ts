import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { adminAuthHook } from '../../../src/api/middleware/admin-auth.js';
import { snapshotEnv } from '../../helpers/env.js';

interface CapturedReply {
  statusCode: number | undefined;
  body: unknown;
}

function makeReply(captured: CapturedReply): FastifyReply {
  const reply = {
    code(status: number) {
      captured.statusCode = status;
      return reply;
    },
    send(payload: unknown) {
      captured.body = payload;
      return reply;
    },
  };
  return reply as unknown as FastifyReply;
}

function makeRequest(authorization?: string): FastifyRequest {
  return { headers: authorization ? { authorization } : {} } as unknown as FastifyRequest;
}

describe('adminAuthHook', () => {
  const env = snapshotEnv(['ADMIN_TOKEN']);
  let captured: CapturedReply;

  beforeEach(() => {
    captured = { statusCode: undefined, body: undefined };
    process.env['ADMIN_TOKEN'] = 'secret-token';
  });

  afterEach(() => {
    env.restore();
  });

  it('returns 503 when ADMIN_TOKEN is not configured', async () => {
    delete process.env['ADMIN_TOKEN'];
    await adminAuthHook(makeRequest('Bearer anything'), makeReply(captured));
    expect(captured.statusCode).toBe(503);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    await adminAuthHook(makeRequest(), makeReply(captured));
    expect(captured.statusCode).toBe(401);
  });

  it('returns 401 for a wrong token', async () => {
    await adminAuthHook(makeRequest('Bearer wrong-token'), makeReply(captured));
    expect(captured.statusCode).toBe(401);
  });

  it('returns 401 for a token differing only in length (timingSafeEqual length guard)', async () => {
    await adminAuthHook(makeRequest('Bearer secret-token-extra'), makeReply(captured));
    expect(captured.statusCode).toBe(401);
  });

  it('passes through (no code/send) for the correct bearer token', async () => {
    await adminAuthHook(makeRequest('Bearer secret-token'), makeReply(captured));
    expect(captured.statusCode).toBeUndefined();
    expect(captured.body).toBeUndefined();
  });
});
