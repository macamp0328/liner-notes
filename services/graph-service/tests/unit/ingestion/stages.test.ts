import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RELOAD_STAGES } from '../../../src/ingestion/stages.js';
import type { ReloadContext, ReloadStageName } from '../../../src/ingestion/stages.js';
import { ingestReleases } from '../../../src/ingestion/ingest.js';
import { enrichLyrics } from '../../../src/enrichment/lyrics.js';
import { enrichMasterData } from '../../../src/enrichment/master-data.js';
import { enrichArtistGenres } from '../../../src/enrichment/artist-genres.js';
import { enrichArtistProfiles } from '../../../src/enrichment/artist-profiles.js';
import { enrichTrackVersions } from '../../../src/enrichment/track-versions.js';
import { enrichMbReleaseEvents } from '../../../src/enrichment/mb-release-events.js';
import { enrichTrackMusicBrainz } from '../../../src/enrichment/track-musicbrainz.js';
import { enrichTrackAcousticBrainz } from '../../../src/enrichment/track-acousticbrainz.js';
import { enrichTrackDeezer } from '../../../src/enrichment/track-deezer.js';
import { enrichNationality } from '../../../src/enrichment/artist-nationality.js';

vi.mock('../../../src/ingestion/ingest.js', () => ({ ingestReleases: vi.fn() }));
vi.mock('../../../src/enrichment/lyrics.js', () => ({ enrichLyrics: vi.fn() }));
vi.mock('../../../src/enrichment/master-data.js', () => ({ enrichMasterData: vi.fn() }));
vi.mock('../../../src/enrichment/artist-genres.js', () => ({ enrichArtistGenres: vi.fn() }));
vi.mock('../../../src/enrichment/artist-profiles.js', () => ({ enrichArtistProfiles: vi.fn() }));
vi.mock('../../../src/enrichment/track-versions.js', () => ({ enrichTrackVersions: vi.fn() }));
vi.mock('../../../src/enrichment/mb-release-events.js', () => ({ enrichMbReleaseEvents: vi.fn() }));
vi.mock('../../../src/enrichment/track-musicbrainz.js', () => ({
  enrichTrackMusicBrainz: vi.fn(),
}));
vi.mock('../../../src/enrichment/track-acousticbrainz.js', () => ({
  enrichTrackAcousticBrainz: vi.fn(),
}));
vi.mock('../../../src/enrichment/track-deezer.js', () => ({ enrichTrackDeezer: vi.fn() }));
vi.mock('../../../src/enrichment/artist-nationality.js', () => ({ enrichNationality: vi.fn() }));

const COUNTS = { enriched: 5, skipped: 1, failed: 0, durationMs: 10 };

const log = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as ReloadContext['log'];

function makeCtx(overrides: Partial<ReloadContext> = {}): ReloadContext {
  return {
    driver: {} as ReloadContext['driver'],
    log,
    username: 'tester',
    discogs: {} as ReloadContext['discogs'],
    musicbrainz: {} as ReloadContext['musicbrainz'],
    acousticbrainz: {} as ReloadContext['acousticbrainz'],
    deezer: {} as ReloadContext['deezer'],
    wikidata: {} as ReloadContext['wikidata'],
    viaf: {} as ReloadContext['viaf'],
    ...overrides,
  };
}

function stage(name: ReloadStageName) {
  const found = RELOAD_STAGES.find((s) => s.name === name);
  if (!found) throw new Error(`stage ${name} not found`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ingestReleases).mockResolvedValue({
    releasesProcessed: 3,
    releasesFailed: 1,
    errors: ['Release 9: boom'],
  });
  for (const fn of [
    enrichLyrics,
    enrichMasterData,
    enrichArtistGenres,
    enrichArtistProfiles,
    enrichTrackVersions,
    enrichMbReleaseEvents,
    enrichTrackMusicBrainz,
    enrichTrackAcousticBrainz,
    enrichTrackDeezer,
    enrichNationality,
  ]) {
    vi.mocked(fn).mockResolvedValue(COUNTS as never);
  }
});

describe('RELOAD_STAGES order', () => {
  it('lists every stage in #154 dependency order with verify last', () => {
    expect(RELOAD_STAGES.map((s) => s.name)).toEqual([
      'releases',
      'lyrics',
      'master-data',
      'artist-genres',
      'artist-profiles',
      'track-versions',
      'mb-release-events',
      'track-musicbrainz',
      'track-acousticbrainz',
      'track-deezer',
      'nationality',
      'verify',
    ]);
  });

  it('runs track-musicbrainz before its acousticbrainz/deezer dependents', () => {
    const names = RELOAD_STAGES.map((s) => s.name);
    expect(names.indexOf('track-musicbrainz')).toBeLessThan(names.indexOf('track-acousticbrainz'));
    expect(names.indexOf('track-musicbrainz')).toBeLessThan(names.indexOf('track-deezer'));
  });
});

describe('stage run() delegates to the right enrich function', () => {
  it('releases → ingestReleases, returning numeric counts only', async () => {
    const result = await stage('releases').run(makeCtx());
    expect(ingestReleases).toHaveBeenCalledOnce();
    expect(result).toEqual({ releasesProcessed: 3, releasesFailed: 1, releaseErrors: 1 });
  });

  it('lyrics → enrichLyrics(driver, log)', async () => {
    const ctx = makeCtx();
    const result = await stage('lyrics').run(ctx);
    expect(enrichLyrics).toHaveBeenCalledWith(ctx.driver, ctx.log);
    expect(result).toEqual(COUNTS);
  });

  it('master-data → enrichMasterData(discogs, driver, log)', async () => {
    const ctx = makeCtx();
    await stage('master-data').run(ctx);
    expect(enrichMasterData).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log);
  });

  it('artist-genres → enrichArtistGenres', async () => {
    await stage('artist-genres').run(makeCtx());
    expect(enrichArtistGenres).toHaveBeenCalledOnce();
  });

  it('artist-profiles → enrichArtistProfiles(discogs, ...)', async () => {
    const ctx = makeCtx();
    await stage('artist-profiles').run(ctx);
    expect(enrichArtistProfiles).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log);
  });

  it('track-versions → enrichTrackVersions', async () => {
    await stage('track-versions').run(makeCtx());
    expect(enrichTrackVersions).toHaveBeenCalledOnce();
  });

  it('mb-release-events → enrichMbReleaseEvents(musicbrainz, ...)', async () => {
    const ctx = makeCtx();
    await stage('mb-release-events').run(ctx);
    expect(enrichMbReleaseEvents).toHaveBeenCalledWith(ctx.musicbrainz, ctx.driver, ctx.log);
  });

  it('track-musicbrainz → enrichTrackMusicBrainz(musicbrainz, ...)', async () => {
    const ctx = makeCtx();
    await stage('track-musicbrainz').run(ctx);
    expect(enrichTrackMusicBrainz).toHaveBeenCalledWith(ctx.musicbrainz, ctx.driver, ctx.log);
  });

  it('track-acousticbrainz → enrichTrackAcousticBrainz(acousticbrainz, ...)', async () => {
    const ctx = makeCtx();
    await stage('track-acousticbrainz').run(ctx);
    expect(enrichTrackAcousticBrainz).toHaveBeenCalledWith(ctx.acousticbrainz, ctx.driver, ctx.log);
  });

  it('track-deezer → enrichTrackDeezer(deezer, ...)', async () => {
    const ctx = makeCtx();
    await stage('track-deezer').run(ctx);
    expect(enrichTrackDeezer).toHaveBeenCalledWith(ctx.deezer, ctx.driver, ctx.log);
  });

  it('nationality → enrichNationality with optional clients passed through', async () => {
    const ctx = makeCtx();
    await stage('nationality').run(ctx);
    expect(enrichNationality).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      ctx.wikidata,
      ctx.discogs,
      ctx.viaf,
    );
  });

  it('nationality passes undefined for null optional clients', async () => {
    const ctx = makeCtx({ wikidata: null, viaf: null });
    await stage('nationality').run(ctx);
    expect(enrichNationality).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      undefined,
      ctx.discogs,
      undefined,
    );
  });

  it('verify is a no-op returning empty counts', async () => {
    expect(await stage('verify').run(makeCtx())).toEqual({});
  });
});

describe('stages skip (return null) when a required client is missing', () => {
  it('releases skips with no discogs client', async () => {
    expect(await stage('releases').run(makeCtx({ discogs: null }))).toBeNull();
    expect(ingestReleases).not.toHaveBeenCalled();
  });

  it('master-data skips with no discogs client', async () => {
    expect(await stage('master-data').run(makeCtx({ discogs: null }))).toBeNull();
    expect(enrichMasterData).not.toHaveBeenCalled();
  });

  it('artist-profiles skips with no discogs client', async () => {
    expect(await stage('artist-profiles').run(makeCtx({ discogs: null }))).toBeNull();
  });

  it('mb-release-events skips with no musicbrainz client', async () => {
    expect(await stage('mb-release-events').run(makeCtx({ musicbrainz: null }))).toBeNull();
    expect(enrichMbReleaseEvents).not.toHaveBeenCalled();
  });

  it('track-musicbrainz skips with no musicbrainz client', async () => {
    expect(await stage('track-musicbrainz').run(makeCtx({ musicbrainz: null }))).toBeNull();
  });

  it('nationality skips with no musicbrainz client', async () => {
    expect(await stage('nationality').run(makeCtx({ musicbrainz: null }))).toBeNull();
    expect(enrichNationality).not.toHaveBeenCalled();
  });
});
