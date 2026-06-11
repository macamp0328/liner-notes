import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { resolveRateLimitMax, resolveTrustCfIp, rateLimitKeyGenerator } from '../../src/server.js';
import { snapshotEnv } from '../helpers/env.js';

const env = snapshotEnv(['NODE_ENV', 'RATE_LIMIT_MAX', 'TRUST_CF_CONNECTING_IP']);

// Minimal request stub: only the fields rateLimitKeyGenerator reads (ip + headers).
function makeRequest(ip: string, cfConnectingIp?: string | string[]): FastifyRequest {
  const headers = cfConnectingIp === undefined ? {} : { 'cf-connecting-ip': cfConnectingIp };
  return { ip, headers } as unknown as FastifyRequest;
}

describe('resolveRateLimitMax', () => {
  afterEach(() => {
    env.restore();
  });

  it('returns an explicit option verbatim, ignoring env', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['RATE_LIMIT_MAX'] = '50';
    expect(resolveRateLimitMax(7)).toBe(7);
  });

  it('is effectively unbounded under NODE_ENV=test so suites do not throttle themselves', () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['RATE_LIMIT_MAX'];
    expect(resolveRateLimitMax()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reads a positive RATE_LIMIT_MAX env value outside test', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['RATE_LIMIT_MAX'] = '50';
    expect(resolveRateLimitMax()).toBe(50);
  });

  it('falls back to the default of 100 when RATE_LIMIT_MAX is unset', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['RATE_LIMIT_MAX'];
    expect(resolveRateLimitMax()).toBe(100);
  });

  it('falls back to the default for a non-positive RATE_LIMIT_MAX', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['RATE_LIMIT_MAX'] = '-5';
    expect(resolveRateLimitMax()).toBe(100);
  });

  it('falls back to the default for an unparseable RATE_LIMIT_MAX', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['RATE_LIMIT_MAX'] = 'not-a-number';
    expect(resolveRateLimitMax()).toBe(100);
  });
});

describe('resolveTrustCfIp', () => {
  afterEach(() => {
    env.restore();
  });

  it('returns an explicit option verbatim, ignoring env', () => {
    process.env['TRUST_CF_CONNECTING_IP'] = 'false';
    expect(resolveTrustCfIp(true)).toBe(true);
  });

  it('is true when TRUST_CF_CONNECTING_IP is exactly "true"', () => {
    process.env['TRUST_CF_CONNECTING_IP'] = 'true';
    expect(resolveTrustCfIp()).toBe(true);
  });

  it('is false when unset (the safe default)', () => {
    delete process.env['TRUST_CF_CONNECTING_IP'];
    expect(resolveTrustCfIp()).toBe(false);
  });

  it('is false for any value other than "true"', () => {
    process.env['TRUST_CF_CONNECTING_IP'] = '1';
    expect(resolveTrustCfIp()).toBe(false);
  });
});

describe('rateLimitKeyGenerator', () => {
  it('returns request.ip when trust is off, even if the header is present', () => {
    const key = rateLimitKeyGenerator(false);
    expect(key(makeRequest('10.0.0.1', '1.2.3.4'))).toBe('10.0.0.1');
  });

  it('returns the cf-connecting-ip header when trust is on', () => {
    const key = rateLimitKeyGenerator(true);
    expect(key(makeRequest('10.0.0.1', '1.2.3.4'))).toBe('1.2.3.4');
  });

  it('uses the first element of an array-valued header', () => {
    const key = rateLimitKeyGenerator(true);
    expect(key(makeRequest('10.0.0.1', ['1.2.3.4', '5.6.7.8']))).toBe('1.2.3.4');
  });

  it('uses the first token (trimmed) of a comma-joined header', () => {
    const key = rateLimitKeyGenerator(true);
    expect(key(makeRequest('10.0.0.1', ' 1.2.3.4 , 5.6.7.8'))).toBe('1.2.3.4');
  });

  it('falls back to request.ip when the header is blank or missing', () => {
    const key = rateLimitKeyGenerator(true);
    expect(key(makeRequest('10.0.0.1', '   '))).toBe('10.0.0.1');
    expect(key(makeRequest('10.0.0.1'))).toBe('10.0.0.1');
  });
});
