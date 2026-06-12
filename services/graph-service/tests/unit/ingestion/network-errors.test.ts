import { describe, it, expect } from 'vitest';
import { transientNetworkCode } from '../../../src/ingestion/network-errors.js';

describe('transientNetworkCode', () => {
  it('returns null for a non-Error value', () => {
    expect(transientNetworkCode('boom')).toBeNull();
    expect(transientNetworkCode(undefined)).toBeNull();
  });

  it('recognizes the undici "fetch failed" message', () => {
    expect(transientNetworkCode(new TypeError('fetch failed'))).toBe('fetch failed');
  });

  it('reads a transient code nested in error.cause', () => {
    const err = new TypeError('connection error');
    (err as Error & { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    expect(transientNetworkCode(err)).toBe('ECONNRESET');
  });

  it('reads a transient code set directly on the error', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' });
    expect(transientNetworkCode(err)).toBe('ETIMEDOUT');
  });

  it('returns null for a non-transient error code', () => {
    const err = Object.assign(new Error('bad cert'), { code: 'CERT_HAS_EXPIRED' });
    expect(transientNetworkCode(err)).toBeNull();
  });

  it('returns null for a plain error with no recognized code', () => {
    expect(transientNetworkCode(new Error('something else'))).toBeNull();
  });

  it('classifies an AbortSignal.timeout TimeoutError (a DOMException matched by name)', () => {
    // A TimeoutError DOMException carries no transient `.code` string (its legacy `.code` is the
    // number 23) and its message is not "fetch failed", so it would fall through to null without the
    // early name-based check — hence that check must run first.
    const err = new DOMException('The operation timed out.', 'TimeoutError');
    expect(transientNetworkCode(err)).toBe('TimeoutError');
  });

  it('leaves a caller-initiated AbortError non-transient', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    expect(transientNetworkCode(err)).toBeNull();
  });
});
