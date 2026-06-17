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

  it('opens and closes a fresh session for each of the 59 statements', async () => {
    await applySchema(driver);
    expect(sessions).toHaveLength(59);
    for (const s of sessions) {
      expect(s.run).toHaveBeenCalledTimes(1);
      expect(s.close).toHaveBeenCalledTimes(1);
    }
  });

  it('creates the musicbrainzId mapping + marker indexes on Artist and Musician (issue #380)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    for (const needle of [
      'artist_musicbrainz_id',
      'musician_musicbrainz_id',
      'artist_mb_id_fetched_at',
      'musician_mb_id_fetched_at',
    ]) {
      expect(stmts.some((s) => s.includes(needle))).toBe(true);
    }
  });

  it('creates the wikidataQid lookup index for the influence join (issue #391)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(
      stmts.some(
        (s) => s.includes('CREATE INDEX artist_wikidata_qid') && s.includes('a.wikidataQid'),
      ),
    ).toBe(true);
  });

  it('creates the Work uniqueness constraint and worksFetchedAt index (issue #336)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('work_mbid') && s.includes('w.mbid IS UNIQUE'))).toBe(true);
    expect(
      stmts.some(
        (s) => s.includes('CREATE INDEX track_works_fetched_at') && s.includes('worksFetchedAt'),
      ),
    ).toBe(true);
  });

  it('creates the musician discogsId and membersFetchedAt indexes (issue #330)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(
      stmts.some(
        (s) => s.includes('CREATE INDEX musician_discogs_id') && s.includes('m.discogsId'),
      ),
    ).toBe(true);
    expect(
      stmts.some(
        (s) =>
          s.includes('CREATE INDEX musician_members_fetched_at') &&
          s.includes('m.membersFetchedAt'),
      ),
    ).toBe(true);
  });

  it('creates the release uniqueness constraint', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('release_discogs_id') && s.includes('IS UNIQUE'))).toBe(
      true,
    );
  });

  it('backfills lyricsStatus=resolved on pre-existing lyric’d tracks (#246)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(
      stmts.some(
        (s) =>
          s.includes('t.lyrics IS NOT NULL') &&
          s.includes('t.lyricsStatus IS NULL') &&
          s.includes("SET t.lyricsStatus = 'resolved'"),
      ),
    ).toBe(true);
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

  it('creates the track MusicBrainz indexes', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('track_recording_mbid'))).toBe(true);
    expect(stmts.some((s) => s.includes('track_isrc'))).toBe(true);
    expect(
      stmts.some(
        (s) =>
          s.includes('CREATE INDEX track_musicbrainz_fetched_at') &&
          s.includes('musicBrainzFetchedAt'),
      ),
    ).toBe(true);
  });

  it('creates the track AcousticBrainz indexes', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(
      stmts.some(
        (s) =>
          s.includes('CREATE INDEX track_acousticbrainz_fetched_at') &&
          s.includes('acousticBrainzFetchedAt'),
      ),
    ).toBe(true);
    expect(stmts.some((s) => s.includes('track_tempo'))).toBe(true);
    expect(stmts.some((s) => s.includes('track_musical_scale'))).toBe(true);
  });

  it('creates the track Deezer index', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(
      stmts.some(
        (s) => s.includes('CREATE INDEX track_deezer_fetched_at') && s.includes('deezerFetchedAt'),
      ),
    ).toBe(true);
  });

  it('drops the superseded boolean-marker indexes and creates the lyrics timestamp index', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('DROP INDEX track_musicbrainz_fetched IF EXISTS'))).toBe(
      true,
    );
    expect(stmts.some((s) => s.includes('DROP INDEX artist_nationality_fetched IF EXISTS'))).toBe(
      true,
    );
    expect(
      stmts.some(
        (s) => s.includes('CREATE INDEX track_lyrics_fetched_at') && s.includes('lyricsFetchedAt'),
      ),
    ).toBe(true);
  });

  it('creates the ReloadJob constraint and ReloadStage/ReloadJob indexes (issue #175)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('reload_job_id') && s.includes('j.jobId IS UNIQUE'))).toBe(
      true,
    );
    expect(stmts.some((s) => s.includes('reload_stage_job') && s.includes('s.jobId'))).toBe(true);
    expect(
      stmts.some((s) => s.includes('reload_job_started_at') && s.includes('j.startedAt')),
    ).toBe(true);
  });

  it('runs one-time cleanup migrations removing the old boolean markers', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(
      stmts.some((s) => s.includes('REMOVE n.nationalityFetched') && !s.includes('FetchedAt')),
    ).toBe(true);
    expect(
      stmts.some(
        (s) =>
          s.includes('REMOVE t.musicBrainzFetched, t.acousticBrainzFetched, t.deezerFetched') &&
          !s.includes('FetchedAt'),
      ),
    ).toBe(true);
  });

  it('cleans up the dropped track-versions stage: index, relationships, property (issue #196)', async () => {
    await applySchema(driver);
    const stmts = sessions.map((s) => (vi.mocked(s.run).mock.calls[0] as [string])[0]);
    expect(stmts.some((s) => s.includes('DROP INDEX track_normalized_title IF EXISTS'))).toBe(true);
    expect(stmts.some((s) => s.includes('MATCH ()-[r:IS_VERSION_OF]->() DELETE r'))).toBe(true);
    expect(
      stmts.some(
        (s) =>
          s.includes('REMOVE t.normalizedTitle') && s.includes('t.normalizedTitle IS NOT NULL'),
      ),
    ).toBe(true);
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
