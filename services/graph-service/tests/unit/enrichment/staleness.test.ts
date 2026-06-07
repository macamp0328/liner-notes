import { describe, it, expect, afterEach } from 'vitest';
import { getStalenessDays } from '../../../src/enrichment/staleness.js';

const ENV_KEY = 'ENRICHMENT_STALENESS_DAYS';

describe('getStalenessDays', () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('defaults to 30 when the env var is unset', () => {
    delete process.env[ENV_KEY];
    expect(getStalenessDays()).toBe(30);
  });

  it('uses a valid positive integer override', () => {
    process.env[ENV_KEY] = '7';
    expect(getStalenessDays()).toBe(7);
  });

  it('falls back to 30 for a non-numeric value', () => {
    process.env[ENV_KEY] = 'soon';
    expect(getStalenessDays()).toBe(30);
  });

  it('falls back to 30 for an empty string', () => {
    process.env[ENV_KEY] = '';
    expect(getStalenessDays()).toBe(30);
  });

  it('honors zero (re-attempt every still-missing node, ignore last-attempt time)', () => {
    process.env[ENV_KEY] = '0';
    expect(getStalenessDays()).toBe(0);
  });

  it('falls back to 30 for a negative value', () => {
    process.env[ENV_KEY] = '-5';
    expect(getStalenessDays()).toBe(30);
  });
});
