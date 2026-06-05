import { describe, it, expect, afterEach } from 'vitest';
import { resolveRateLimitMax } from '../../src/server.js';
import { snapshotEnv } from '../helpers/env.js';

const env = snapshotEnv(['NODE_ENV', 'RATE_LIMIT_MAX']);

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
