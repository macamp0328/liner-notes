import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applySchema } from '../../src/db/schema.js';
import type { Driver, Session } from 'neo4j-driver';

const makeSession = (): Session => {
  const session = {
    run: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return session;
};

const makeDriver = (session: Session): Driver =>
  ({ session: () => session }) as unknown as Driver;

describe('applySchema', () => {
  let session: Session;
  let driver: Driver;

  beforeEach(() => {
    session = makeSession();
    driver = makeDriver(session);
  });

  it('runs all 11 schema statements', async () => {
    await applySchema(driver);
    expect(session.run).toHaveBeenCalledTimes(11);
    expect(session.close).toHaveBeenCalledTimes(11);
  });

  it('creates the release uniqueness constraint', async () => {
    await applySchema(driver);
    const calls = vi.mocked(session.run).mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('release_discogs_id') && s.includes('IS UNIQUE'))).toBe(true);
  });

  it('creates the trackLyrics full-text index', async () => {
    await applySchema(driver);
    const calls = vi.mocked(session.run).mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('trackLyrics') && s.includes('FULLTEXT INDEX'))).toBe(true);
  });

  it('closes the session after each statement even on error', async () => {
    vi.mocked(session.run).mockRejectedValueOnce(new Error('already exists'));
    await applySchema(driver);
    // close still called for the failed statement
    expect(session.close).toHaveBeenCalled();
  });

  it('does not throw when a statement fails (idempotency guard)', async () => {
    vi.mocked(session.run).mockRejectedValue(new Error('constraint already exists'));
    await expect(applySchema(driver)).resolves.toBeUndefined();
  });
});
