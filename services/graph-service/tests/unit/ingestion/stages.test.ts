import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RELOAD_STAGES,
  foldBreakerCounts,
  clientBreakerSnapshot,
} from '../../../src/ingestion/stages.js';
import type {
  ReloadContext,
  ReloadStageName,
  StageDescriptor,
} from '../../../src/ingestion/stages.js';
import type { CircuitBreakerSnapshot } from '../../../src/ingestion/circuit-breaker.js';
import { validateStageGraph } from '../../../src/ingestion/scheduler.js';
import { ingestReleases } from '../../../src/ingestion/ingest.js';
import { enrichLyrics } from '../../../src/enrichment/lyrics.js';
import { enrichMasterData } from '../../../src/enrichment/master-data.js';
import { enrichArtistGenres } from '../../../src/enrichment/artist-genres.js';
import { enrichArtistProfiles } from '../../../src/enrichment/artist-profiles.js';
import { enrichLabelHierarchy } from '../../../src/enrichment/label-hierarchy.js';
import { enrichGroupMembers } from '../../../src/enrichment/group-members.js';
import { enrichPersonReconciliation } from '../../../src/enrichment/person-reconciliation.js';
import { enrichMbReleaseEvents } from '../../../src/enrichment/mb-release-events.js';
import { enrichTrackMusicBrainz } from '../../../src/enrichment/track-musicbrainz.js';
import { enrichTrackWorks } from '../../../src/enrichment/track-works.js';
import { enrichTrackAcousticBrainz } from '../../../src/enrichment/track-acousticbrainz.js';
import { enrichTrackDeezer } from '../../../src/enrichment/track-deezer.js';
import { enrichNationality } from '../../../src/enrichment/artist-nationality.js';
import { enrichArtistWikidata } from '../../../src/enrichment/artist-wikidata.js';

vi.mock('../../../src/ingestion/ingest.js', () => ({ ingestReleases: vi.fn() }));
vi.mock('../../../src/enrichment/lyrics.js', () => ({
  enrichLyrics: vi.fn(),
  resolveReloadLyricsConcurrency: vi.fn(() => 3),
}));
vi.mock('../../../src/enrichment/master-data.js', () => ({ enrichMasterData: vi.fn() }));
vi.mock('../../../src/enrichment/artist-genres.js', () => ({ enrichArtistGenres: vi.fn() }));
vi.mock('../../../src/enrichment/artist-profiles.js', () => ({ enrichArtistProfiles: vi.fn() }));
vi.mock('../../../src/enrichment/label-hierarchy.js', () => ({ enrichLabelHierarchy: vi.fn() }));
vi.mock('../../../src/enrichment/group-members.js', () => ({ enrichGroupMembers: vi.fn() }));
vi.mock('../../../src/enrichment/person-reconciliation.js', () => ({
  enrichPersonReconciliation: vi.fn(),
}));
vi.mock('../../../src/enrichment/mb-release-events.js', () => ({ enrichMbReleaseEvents: vi.fn() }));
vi.mock('../../../src/enrichment/track-musicbrainz.js', () => ({
  enrichTrackMusicBrainz: vi.fn(),
}));
vi.mock('../../../src/enrichment/track-works.js', () => ({ enrichTrackWorks: vi.fn() }));
vi.mock('../../../src/enrichment/track-acousticbrainz.js', () => ({
  enrichTrackAcousticBrainz: vi.fn(),
}));
vi.mock('../../../src/enrichment/track-deezer.js', () => ({ enrichTrackDeezer: vi.fn() }));
vi.mock('../../../src/enrichment/artist-nationality.js', () => ({ enrichNationality: vi.fn() }));
vi.mock('../../../src/enrichment/artist-wikidata.js', () => ({ enrichArtistWikidata: vi.fn() }));

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
    enrichLabelHierarchy,
    enrichGroupMembers,
    enrichPersonReconciliation,
    enrichMbReleaseEvents,
    enrichTrackMusicBrainz,
    enrichTrackWorks,
    enrichTrackAcousticBrainz,
    enrichTrackDeezer,
    enrichNationality,
    enrichArtistWikidata,
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
      'label-hierarchy',
      'group-members',
      'person-reconciliation',
      'track-musicbrainz',
      'track-works',
      'mb-release-events',
      'lyrics',
      'track-acousticbrainz',
      'track-deezer',
      'nationality',
      'artist-wikidata',
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

  it('runs person-reconciliation after both single-axis batched writers (#330 deadlock avoidance)', () => {
    // The dual-axis writer must not overlap artist-genres (Artist) or group-members (Musician).
    expect(stage('person-reconciliation').deps).toEqual(
      expect.arrayContaining(['artist-genres', 'group-members']),
    );
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
    for (const name of [
      'releases',
      'master-data',
      'artist-profiles',
      'label-hierarchy',
      'group-members',
      'nationality',
      'artist-wikidata',
    ] as const) {
      expect(stage(name).resources).toContain('discogs');
    }
  });

  it('serialises the two Wikidata-client stages via the wikidata lane (#341)', () => {
    // nationality and artist-wikidata both drive the one shared ctx.wikidata client.
    for (const name of ['nationality', 'artist-wikidata'] as const) {
      expect(stage(name).resources).toContain('wikidata');
    }
  });

  it('tags every MusicBrainz-client stage with the musicbrainz lane (shared rate limiter)', () => {
    for (const name of [
      'track-musicbrainz',
      'track-works',
      'mb-release-events',
      'nationality',
    ] as const) {
      expect(stage(name).resources).toContain('musicbrainz');
    }
  });

  it('serialises the batched Track writers via the track lane, exempting per-node lyrics', () => {
    for (const name of [
      'track-musicbrainz',
      'track-works',
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
    // #330: person-reconciliation is pure Cypher; it's serialized after the two single-axis batched
    // writers via deps, not a resource lane.
    expect(stage('person-reconciliation').resources).toEqual([]);
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

  it('lyrics → enrichLyrics(driver, log, onProgress) with the reload concurrency (#372)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    const result = await stage('lyrics').run(ctx, onProgress);
    // The reload passes RELOAD_LYRICS_CONCURRENCY (mocked to 3) via the opts override; no clients injected.
    expect(enrichLyrics).toHaveBeenCalledWith(ctx.driver, ctx.log, onProgress, undefined, {
      concurrency: 3,
    });
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

  it('person-reconciliation → enrichPersonReconciliation(driver, log)', async () => {
    const ctx = makeCtx();
    await stage('person-reconciliation').run(ctx);
    expect(enrichPersonReconciliation).toHaveBeenCalledWith(ctx.driver, ctx.log);
  });

  it('artist-profiles → enrichArtistProfiles(discogs, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('artist-profiles').run(ctx, onProgress);
    expect(enrichArtistProfiles).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log, onProgress);
  });

  it('label-hierarchy → enrichLabelHierarchy(discogs, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('label-hierarchy').run(ctx, onProgress);
    expect(enrichLabelHierarchy).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log, onProgress);
  });

  it('group-members → enrichGroupMembers(discogs, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('group-members').run(ctx, onProgress);
    expect(enrichGroupMembers).toHaveBeenCalledWith(ctx.discogs, ctx.driver, ctx.log, onProgress);
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

  it('track-works → enrichTrackWorks(musicbrainz, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('track-works').run(ctx, onProgress);
    expect(enrichTrackWorks).toHaveBeenCalledWith(ctx.musicbrainz, ctx.driver, ctx.log, onProgress);
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
      onProgress,
    );
  });

  it('nationality passes undefined for null optional clients', async () => {
    const ctx = makeCtx({ wikidata: null });
    const onProgress = vi.fn();
    await stage('nationality').run(ctx, onProgress);
    expect(enrichNationality).toHaveBeenCalledWith(
      ctx.musicbrainz,
      ctx.driver,
      ctx.log,
      undefined,
      ctx.discogs,
      onProgress,
    );
  });

  it('artist-wikidata → enrichArtistWikidata(wikidata, discogs, ..., onProgress)', async () => {
    const ctx = makeCtx();
    const onProgress = vi.fn();
    await stage('artist-wikidata').run(ctx, onProgress);
    expect(enrichArtistWikidata).toHaveBeenCalledWith(
      ctx.wikidata,
      ctx.discogs,
      ctx.driver,
      ctx.log,
      onProgress,
    );
  });

  it('artist-wikidata passes undefined when the discogs client is null (P1953 join still works)', async () => {
    const ctx = makeCtx({ discogs: null });
    const onProgress = vi.fn();
    await stage('artist-wikidata').run(ctx, onProgress);
    expect(enrichArtistWikidata).toHaveBeenCalledWith(
      ctx.wikidata,
      undefined,
      ctx.driver,
      ctx.log,
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

  it('label-hierarchy skips with no discogs client', async () => {
    expect(await stage('label-hierarchy').run(makeCtx({ discogs: null }))).toBeNull();
    expect(enrichLabelHierarchy).not.toHaveBeenCalled();
  });

  it('group-members skips with no discogs client', async () => {
    expect(await stage('group-members').run(makeCtx({ discogs: null }))).toBeNull();
    expect(enrichGroupMembers).not.toHaveBeenCalled();
  });

  it('mb-release-events skips with no musicbrainz client', async () => {
    expect(await stage('mb-release-events').run(makeCtx({ musicbrainz: null }))).toBeNull();
    expect(enrichMbReleaseEvents).not.toHaveBeenCalled();
  });

  it('track-musicbrainz skips with no musicbrainz client', async () => {
    expect(await stage('track-musicbrainz').run(makeCtx({ musicbrainz: null }))).toBeNull();
  });

  it('track-works skips with no musicbrainz client', async () => {
    expect(await stage('track-works').run(makeCtx({ musicbrainz: null }))).toBeNull();
    expect(enrichTrackWorks).not.toHaveBeenCalled();
  });

  it('nationality skips with no musicbrainz client', async () => {
    expect(await stage('nationality').run(makeCtx({ musicbrainz: null }))).toBeNull();
    expect(enrichNationality).not.toHaveBeenCalled();
  });

  it('artist-wikidata skips with no wikidata client', async () => {
    expect(await stage('artist-wikidata').run(makeCtx({ wikidata: null }))).toBeNull();
    expect(enrichArtistWikidata).not.toHaveBeenCalled();
  });
});

describe('breaker count surfacing (#242)', () => {
  const snap = (source: string, open: boolean, fatalCount: number): CircuitBreakerSnapshot => ({
    source,
    state: open ? 'open' : 'closed',
    open,
    consecutiveFatals: open ? fatalCount : 0,
    fatalCount,
    trippedAt: open ? 1 : null,
  });

  const clientStub = (
    s: CircuitBreakerSnapshot,
  ): { breakerSnapshot: () => CircuitBreakerSnapshot } => ({
    breakerSnapshot: () => s,
  });

  it('clientBreakerSnapshot returns null for non-ctx sources (genius/lrclib)', () => {
    const ctx = makeCtx();
    expect(clientBreakerSnapshot(ctx, 'genius')).toBeNull();
    expect(clientBreakerSnapshot(ctx, 'lrclib')).toBeNull();
  });

  it('clientBreakerSnapshot returns null for an unconfigured (null) client', () => {
    const ctx = makeCtx({ musicbrainz: null });
    expect(clientBreakerSnapshot(ctx, 'musicbrainz')).toBeNull();
  });

  it('folds a tripped source into the stage counts', () => {
    const ctx = makeCtx({
      musicbrainz: clientStub(
        snap('musicbrainz', true, 7),
      ) as unknown as ReloadContext['musicbrainz'],
    });
    const descriptor = {
      name: 'track-musicbrainz',
      sources: ['musicbrainz'],
    } as unknown as StageDescriptor;

    const counts = foldBreakerCounts(ctx, descriptor, { releasesProcessed: 3 });

    expect(counts).toMatchObject({
      releasesProcessed: 3,
      musicbrainzBreakerOpen: 1,
      musicbrainzFatals: 7,
    });
  });

  it('reports a closed breaker as open=0 and skips null clients', () => {
    const ctx = makeCtx({
      deezer: clientStub(snap('deezer', false, 0)) as unknown as ReloadContext['deezer'],
      wikidata: null,
    });
    const descriptor = {
      name: 'nationality',
      sources: ['deezer', 'wikidata'],
    } as unknown as StageDescriptor;

    const counts = foldBreakerCounts(ctx, descriptor, {});

    expect(counts).toEqual({ deezerBreakerOpen: 0, deezerFatals: 0 });
  });

  it('is a no-op when the stage declares no sources', () => {
    expect(
      foldBreakerCounts(makeCtx(), { name: 'artist-genres' } as StageDescriptor, { a: 1 }),
    ).toEqual({ a: 1 });
  });
});
