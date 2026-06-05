import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Record as Neo4jRecord } from 'neo4j-driver';
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

function makeRecord(fields: Record<string, unknown>): Neo4jRecord {
  return {
    get: vi.fn().mockImplementation((key: string) => fields[key]),
  } as unknown as Neo4jRecord;
}

const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

describe('aggregateArtistGenres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns updated artist count from query result', async () => {
    const record = makeRecord({ updated: int(7) });
    const { session, runSpy } = makeMockSession({ records: [record] });

    const updated = await aggregateArtistGenres(makeMockDriver(session));

    expect(updated).toBe(7);
    expect(runSpy.mock.calls[0]?.[0]).toContain('IN_GENRE');
    expect(runSpy.mock.calls[0]?.[0]).toContain('SET a.genres = genres');
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] });

    const updated = await aggregateArtistGenres(makeMockDriver(session));

    expect(updated).toBe(0);
  });

  it('closes session when query fails', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    await expect(aggregateArtistGenres(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('aggregateArtistStyles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns updated artist count from query result', async () => {
    const record = makeRecord({ updated: int(4) });
    const { session, runSpy } = makeMockSession({ records: [record] });

    const updated = await aggregateArtistStyles(makeMockDriver(session));

    expect(updated).toBe(4);
    expect(runSpy.mock.calls[0]?.[0]).toContain('IN_STYLE');
    expect(runSpy.mock.calls[0]?.[0]).toContain('SET a.styles = styles');
  });

  it('returns 0 when no records are returned', async () => {
    const { session } = makeMockSession({ records: [] });

    const updated = await aggregateArtistStyles(makeMockDriver(session));

    expect(updated).toBe(0);
  });

  it('closes session when query fails', async () => {
    const session = {
      run: vi.fn().mockRejectedValue(new Error('DB error')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;

    await expect(aggregateArtistStyles(makeMockDriver(session))).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
