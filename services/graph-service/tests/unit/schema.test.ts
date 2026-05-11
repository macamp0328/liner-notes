import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { applySchema } from '../../src/db/schema.js';
import type { Driver, Session } from 'neo4j-driver';

const makeSession = (): Session =>
  ({
    run: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Session;

describe('applySchema', () => {
  let sessions: Session[];
  let driver: Driver;

  beforeEach(() => {
    sessions = [];
    driver = {
      session: vi.fn(() => {
        const s = makeSession();
        sessions.push(s);
        return s;
      }),
    } as unknown as Driver;
  });

  it('opens and closes a fresh session for each of the 15 statements', async () => {
    await applySchema(driver);
    expect(sessions).toHaveLength(15);
    for (const s of sessions) {
      expect(s.run).toHaveBeenCalledTimes(1);
      expect(s.close).toHaveBeenCalledTimes(1);
    }
  });

  it('creates the release uniqueness constraint', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('release_discogs_id') && s.includes('IS UNIQUE'))).toBe(
      true,
    );
  });

  it('creates the trackLyrics full-text index', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('trackLyrics') && s.includes('FULLTEXT INDEX'))).toBe(true);
  });

  it('creates the releaseArtistTrackSearch and lyricsSearch full-text indexes', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('releaseArtistTrackSearch'))).toBe(true);
    expect(stmts.some((s) => s.includes('lyricsSearch'))).toBe(true);
  });

  it('closes the session even when run() throws', async () => {
    (driver.session as Mock).mockImplementationOnce(() => {
      const s = makeSession();
      vi.mocked(s.run).mockRejectedValue(new Error('permission denied'));
      sessions.push(s);
      return s;
    });
    await expect(applySchema(driver)).rejects.toThrow('permission denied');
    expect(sessions[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('propagates unexpected schema errors (does not swallow them)', async () => {
    (driver.session as Mock).mockImplementationOnce(() => {
      const s = makeSession();
      vi.mocked(s.run).mockRejectedValue(new Error('could not connect'));
      sessions.push(s);
      return s;
    });
    await expect(applySchema(driver)).rejects.toThrow('could not connect');
  });
});
