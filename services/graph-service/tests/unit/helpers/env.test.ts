import { describe, it, expect, afterEach } from 'vitest';
import { snapshotEnv } from '../../helpers/env.js';

// Throwaway keys no production code reads, so mutating them can't affect any other test.
const KEY_A = '__ENV_SNAPSHOT_TEST_A__';
const KEY_B = '__ENV_SNAPSHOT_TEST_B__';

describe('snapshotEnv', () => {
  afterEach(() => {
    delete process.env[KEY_A];
    delete process.env[KEY_B];
  });

  it('restore() puts back a key that had a value at snapshot time', () => {
    process.env[KEY_A] = 'original';
    const env = snapshotEnv([KEY_A]);

    process.env[KEY_A] = 'mutated';
    env.restore();

    expect(process.env[KEY_A]).toBe('original');
  });

  it('restore() deletes a key that was unset at snapshot time', () => {
    delete process.env[KEY_A];
    const env = snapshotEnv([KEY_A]);

    process.env[KEY_A] = 'set-during-test';
    env.restore();

    expect(process.env[KEY_A]).toBeUndefined();
    expect(KEY_A in process.env).toBe(false);
  });

  it('clear() deletes all managed keys', () => {
    process.env[KEY_A] = 'a';
    process.env[KEY_B] = 'b';
    const env = snapshotEnv([KEY_A, KEY_B]);

    env.clear();

    expect(process.env[KEY_A]).toBeUndefined();
    expect(process.env[KEY_B]).toBeUndefined();
  });

  it('captures values at call time, not at restore time', () => {
    process.env[KEY_A] = 'at-snapshot';
    const env = snapshotEnv([KEY_A]);

    process.env[KEY_A] = 'changed-after-snapshot';
    env.restore();

    expect(process.env[KEY_A]).toBe('at-snapshot');
  });

  it('restore() is idempotent after clear() — the suite lifecycle', () => {
    process.env[KEY_A] = 'a';
    delete process.env[KEY_B];
    const env = snapshotEnv([KEY_A, KEY_B]);

    // Mimic a beforeEach baseline reset followed by per-test mutation.
    env.clear();
    process.env[KEY_B] = 'set-by-a-test';

    env.restore();

    expect(process.env[KEY_A]).toBe('a');
    expect(process.env[KEY_B]).toBeUndefined();
  });
});
