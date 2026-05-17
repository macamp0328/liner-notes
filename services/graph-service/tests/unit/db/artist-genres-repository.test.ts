import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import {
  aggregateArtistGenres,
  aggregateArtistStyles,
} from '../../../src/db/artist-genres-repository.js';

function makeMockSession(runResult: unknown = { records: [] }): {
  session: Session;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = vi.fn().mockResolvedValue(runResult);
  const session = {
    run: runSpy,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

const makeInt = (n: number) => ({ toNumber: () => n });

describe('aggregateArtistGenres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the count of updated artists', async () => {
    const record = { get: vi.fn().mockReturnValue(makeInt(5)) };
    const { session } = makeMockSession({ records: [record] } as unknown as Result);
    const count = await aggregateArtistGenres(makeMockDriver(session));
    expect(count).toBe(5);
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const count = await aggregateArtistGenres(makeMockDriver(session));
    expect(count).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(aggregateArtistGenres(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('aggregateArtistStyles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the count of updated artists', async () => {
    const record = { get: vi.fn().mockReturnValue(makeInt(3)) };
    const { session } = makeMockSession({ records: [record] } as unknown as Result);
    const count = await aggregateArtistStyles(makeMockDriver(session));
    expect(count).toBe(3);
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] } as unknown as Result);
    const count = await aggregateArtistStyles(makeMockDriver(session));
    expect(count).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(aggregateArtistStyles(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
