import { describe, it, expect, vi, afterEach } from 'vitest';
import { jitteredBackoffMs } from '../../../src/ingestion/backoff.js';

describe('jitteredBackoffMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the floor (base/2) when random() is 0', () => {
    expect(jitteredBackoffMs(4000, { random: () => 0 })).toBe(2000);
  });

  it('returns 0.75*base at the midpoint (random() = 0.5)', () => {
    expect(jitteredBackoffMs(4000, { random: () => 0.5 })).toBe(3000);
  });

  it('returns the ceiling (base) when random() is 1 — i.e. the pre-jitter value', () => {
    expect(jitteredBackoffMs(4000, { random: () => 1 })).toBe(4000);
  });

  it('never exceeds base for any draw — the per-client 32s cap is preserved', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const v = jitteredBackoffMs(32_000, { random: () => r });
      expect(v).toBeGreaterThanOrEqual(16_000);
      expect(v).toBeLessThanOrEqual(32_000);
    }
  });

  it('floors at Retry-After when it exceeds the jittered backoff', () => {
    // equal jitter of 4000 ∈ [2000, 4000]; a 5000ms Retry-After wins at either extreme
    expect(jitteredBackoffMs(4000, { retryAfterMs: 5000, random: () => 0 })).toBe(5000);
    expect(jitteredBackoffMs(4000, { retryAfterMs: 5000, random: () => 1 })).toBe(5000);
  });

  it('jitters above Retry-After when the backoff is larger', () => {
    // jitter floor 2000 already exceeds the 1000ms Retry-After
    expect(jitteredBackoffMs(4000, { retryAfterMs: 1000, random: () => 0 })).toBe(2000);
  });

  it('rounds to an integer on an odd base', () => {
    // 3/2 + 0.5 * (3/2) = 1.5 + 0.75 = 2.25 → 2
    expect(jitteredBackoffMs(3, { random: () => 0.5 })).toBe(2);
  });

  it('treats a 0 base as 0 (jitter no-op), still honoring Retry-After', () => {
    expect(jitteredBackoffMs(0, { random: () => 0.5 })).toBe(0);
    expect(jitteredBackoffMs(0, { retryAfterMs: 5000, random: () => 0.5 })).toBe(5000);
  });

  it('defaults to Math.random when no random is provided', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(jitteredBackoffMs(4000)).toBe(2000);
    expect(spy).toHaveBeenCalled();
  });

  it('stays within [base/2, base] across many real draws (default RNG)', () => {
    for (let i = 0; i < 100; i++) {
      const v = jitteredBackoffMs(4000);
      expect(v).toBeGreaterThanOrEqual(2000);
      expect(v).toBeLessThanOrEqual(4000);
    }
  });
});
