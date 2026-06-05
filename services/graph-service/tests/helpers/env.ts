export interface EnvSnapshot {
  /** Delete every managed key, resetting them to a clean (unset) baseline. */
  clear(): void;
  /** Restore every managed key to the value it held when snapshotEnv was called. */
  restore(): void;
}

/**
 * Snapshot the current values of the given process.env keys so a test suite can mutate
 * them freely and put them back afterwards. Lives under tests/ (never imported by src/)
 * so production code can't depend on it.
 *
 * restore() replays the captured snapshot rather than reading current state, so it is
 * idempotent and safe to call after clear() — the pattern a suite uses when it clears to
 * a baseline before each test and restores once at the end.
 */
export function snapshotEnv(keys: readonly string[]): EnvSnapshot {
  const original = new Map<string, string | undefined>();
  for (const key of keys) {
    original.set(key, process.env[key]);
  }
  return {
    clear(): void {
      for (const key of keys) {
        delete process.env[key];
      }
    },
    restore(): void {
      for (const [key, value] of original) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}
