import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  BULK_OUTBOUND_TIMEOUT_MS,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  resolveOutboundTimeoutMs,
} from '../../../src/ingestion/outbound-timeout.js';
import { snapshotEnv } from '../../helpers/env.js';

const env = snapshotEnv(['OUTBOUND_REQUEST_TIMEOUT_MS']);

describe('resolveOutboundTimeoutMs', () => {
  beforeEach(() => env.clear());
  afterAll(() => env.restore());

  it('returns the per-client default when the var is unset', () => {
    expect(resolveOutboundTimeoutMs(DEFAULT_OUTBOUND_TIMEOUT_MS)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
    expect(resolveOutboundTimeoutMs(BULK_OUTBOUND_TIMEOUT_MS)).toBe(BULK_OUTBOUND_TIMEOUT_MS);
  });

  it('returns the parsed env value when it is a valid positive integer (overrides all clients)', () => {
    process.env['OUTBOUND_REQUEST_TIMEOUT_MS'] = '45000';
    expect(resolveOutboundTimeoutMs(DEFAULT_OUTBOUND_TIMEOUT_MS)).toBe(45000);
    // Overrides even the bulk default.
    expect(resolveOutboundTimeoutMs(BULK_OUTBOUND_TIMEOUT_MS)).toBe(45000);
  });

  it.each(['', 'abc', '0', '-5', 'NaN'])(
    'falls back to the default on a malformed or non-positive value (%j)',
    (raw) => {
      process.env['OUTBOUND_REQUEST_TIMEOUT_MS'] = raw;
      expect(resolveOutboundTimeoutMs(DEFAULT_OUTBOUND_TIMEOUT_MS)).toBe(
        DEFAULT_OUTBOUND_TIMEOUT_MS,
      );
    },
  );

  it('exposes 30s standard / 60s bulk defaults', () => {
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
    expect(BULK_OUTBOUND_TIMEOUT_MS).toBe(60_000);
  });
});
