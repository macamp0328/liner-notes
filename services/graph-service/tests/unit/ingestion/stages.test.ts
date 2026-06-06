import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RELOAD_STAGES } from '../../../src/ingestion/stages.js';
import type { ReloadContext, ReloadStageName } from '../../../src/ingestion/stages.js';
import { validateStageGraph } from '../../../src/ingestion/scheduler.js';
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

function transitiveDeps(name: ReloadStageName): Set<string> {
  const out = new Set<string>();
  const visit = (n: ReloadStageName): void => {
    for (const d of stage(n).deps) {
      if (!out.has(d)) {
        out.add(d);
        visit(d);
      }
    }
  };
  visit(name);
  return out;
}

describe('RELOAD_STAGES order', () => {
  it('front-loads the gate + cheap stages, defers the slow ones, verify last', () => {
    expect(RELOAD_STAGES.map((s) => s.name)).toEqual([
      'releases',
      'master-data',
      'artist-profiles',
      'artist-genres',
      'track-versions',
      'track-musicbrainz',
      'mb-release-events',
      'lyrics',
      'track-acousticbrainz',
      'track-deezer',
      'nationality',
      'verify',
    ]);
  });

  it('is a valid topological sort — every dep appears earlier in the list', () => {
    const seen = new Set<string>();
    for (const s of RELOAD_STAGES) {
      for (const d of s.deps) expect(seen.has(d)).toBe(true);
      seen.add(s.name);
    }
  });
});

describe('RELOAD_STAGES dependency graph', () => {
  it('is well-formed (deps reference real stages, acyclic)', () => {
    expect(() => validateStageGraph(RELOAD_STAGES)).not.toThrow();
  });

  it('makes releases a (transitive) prerequisite of every other stage', () => {
    for (const s of RELOAD_STAGES) {
      if (s.name === 'releases') continue;
      expect(transitiveDeps(s.name).has('releases')).toBe(true);
    }
  });

  it('runs mb-release-events after master-data (needs the Master nodes it creates)', () => {
    expect(stage('mb-release-events').deps).toContain('master-data');
  });

  it('runs track-acousticbrainz and track-deezer after track-musicbrainz', () => {
    expect(stage('track-acousticbrainz').deps).toContain('track-musicbrainz');
    expect(stage('track-deezer').deps).toContain('track-musicbrainz');
  });

  it('makes verify depend on every other stage so it runs strictly last', () => {
    const others = RELOAD_STAGES.filter((s) => s.name !== 'verify')
      .map((s) => s.name)
      .sort();
    expect([...stage('verify').deps].sort()).toEqual(others);
  });
});

describe('RELOAD_STAGES resource lanes', () => {
  it('tags every Discogs-client stage with the discogs lane (shared rate limiter)', () => {
    for (const name of ['releases', 'master-data', 'artist-profiles', 'nationality'] as const) {
      expect(stage(name).resources).toContain('discogs');
    }
  });

  it('tags every MusicBrainz-client stage with the musicbrainz lane (shared rate limiter)', () => {
    for (const name of ['track-musicbrainz', 'mb-release-events', 'nationality'] as const) {
      expect(stage(name).resources).toContain('musicbrainz');
    }
  });

  it('serialises the batched Track writers via the track lane, exempting per-node lyrics', () => {
    for (const name of [
      'track-versions',
      'track-musicbrainz',
      'track-acousticbrainz',
      'track-deezer',
    ] as const) {
      expect(stage(name).resources).toContain('track');
    }
    // lyrics writes one Track per transaction → deadlock-immune → intentionally untagged.
    expect(stage('lyrics').resources).not.toContain('track');
  });

  it('leaves the pure-Cypher and lyrics stages off every rate-limited lane', () => {
    expect(stage('artist-genres').resources).toEqual([]);
    expect(stage('lyrics').resources).toEqual([]);
  });
});

describe('stage run() delegates to the right enrich function', () => {
  it('releases → ingestReleases, forwarding onProgress and returning numeric counts only', async () => {
    const onProgress = vi.fn();
    const result = await stage('releases').run(makeCtx(), onProgress);
    expect(ingestReleases).toHaveBeenCalledOnce();
    const ctx = makeCtx();
    expect(ingestReleases).toHaveBeenCalledWith(
      ctx.discogs,
      ctx.driver,
      ctx.username,
      ctx.log,
      onProgress,
    );
    expect(result).toEqual({ releasesProcessed: 3, releasesFailed: 1, releaseErrors: 1 });
  });

  it('lyrics → enrichLyrics(driver, log, onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    const result = await stage('lyrics').run(ctx, onProgress);
    expect(enrichLyrics).toHaveBeenCalledWith(ctx.driver, ctx.log, onProgress);
    expect(result).toEqual(COUNTS);
  });

  it('master-data → enrichMasterData(discogs, driver, log, onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('master-data').run(ctx, onProgress);
    expect(enrichMasterData).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log, onProgress);
  });

  it('artist-genres → enrichArtistGenres', async () => {
    await stage('artist-genres').run(makeCtx());
    expect(enrichArtistGenres).toHaveBeenCalledOnce();
  });

  it('artist-profiles → enrichArtistProfiles(discogs, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('artist-profiles').run(ctx, onProgress);
    expect(enrichArtistProfiles).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log, onProgress);
  });

  it('track-versions → enrichTrackVersions(driver, log, onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('track-versions').run(ctx, onProgress);
    expect(enrichTrackVersions).toHaveBeenCalledWith(ctx.driver, ctx.log, onProgress);
  });

  it('mb-release-events → enrichMbReleaseEvents(musicbrainz, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('mb-release-events').run(ctx, onProgress);
    expect(enrichMbReleaseEvents).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      onProgress,
    );
  });

  it('track-musicbrainz → enrichTrackMusicBrainz(musicbrainz, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('track-musicbrainz').run(ctx, onProgress);
    expect(enrichTrackMusicBrainz).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      onProgress,
    );
  });

  it('track-acousticbrainz → enrichTrackAcousticBrainz(acousticbrainz, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('track-acousticbrainz').run(ctx, onProgress);
    expect(enrichTrackAcousticBrainz).toHaveBeenCalledWith(
      ctx.acousticbrainz,
      ctx.driver,
      ctx.log,
      onProgress,
    );
  });

  it('track-deezer → enrichTrackDeezer(deezer, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('track-deezer').run(ctx, onProgress);
    expect(enrichTrackDeezer).toHaveBeenCalledWith(ctx.deezer, ctx.driver, ctx.log, onProgress);
  });

  it('nationality → enrichNationality with optional clients + onProgress passed through', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('nationality').run(ctx, onProgress);
    expect(enrichNationality).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      ctx.wikidata,
      ctx.discogs,
      ctx.viaf,
      onProgress,
    );
  });

  it('nationality passes undefined for null optional clients', async () => {
    const ctx = makeCtx({ wikidata: null, viaf: null });
    const onProgress = vi.fn();
    await stage('nationality').run(ctx, onProgress);
    expect(enrichNationality).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      undefined,
      ctx.discogs,
      undefined,
      onProgress,
    );
  });

  it('verify descriptor run is a no-op — the real gate runs in the orchestrator', async () => {
    // The coverage gate lives in runVerifyGate (it needs cross-stage ranStages); this
    // descriptor exists only for sequence ordering and job-node creation.
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
