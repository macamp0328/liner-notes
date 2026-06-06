import type { Driver } from 'neo4j-driver';
import type { DiscogsClient, Logger } from './discogs-client.js';
import type { MusicBrainzClient } from './musicbrainz-client.js';
import type { AcousticBrainzClient } from './acousticbrainz-client.js';
import type { DeezerClient } from './deezer-client.js';
import type { WikidataClient } from './wikidata-client.js';
import type { VIAFClient } from './viaf-client.js';
import { ingestReleases } from './ingest.js';
import { enrichLyrics } from '../enrichment/lyrics.js';
import { enrichMasterData } from '../enrichment/master-data.js';
import { enrichArtistGenres } from '../enrichment/artist-genres.js';
import { enrichArtistProfiles } from '../enrichment/artist-profiles.js';
import { enrichTrackVersions } from '../enrichment/track-versions.js';
import { enrichMbReleaseEvents } from '../enrichment/mb-release-events.js';
import { enrichTrackMusicBrainz } from '../enrichment/track-musicbrainz.js';
import { enrichTrackAcousticBrainz } from '../enrichment/track-acousticbrainz.js';
import { enrichTrackDeezer } from '../enrichment/track-deezer.js';
import { enrichNationality } from '../enrichment/artist-nationality.js';
import type { ProgressReporter } from '../enrichment/progress.js';

/**
 * Stage names in the orchestrated reload, in #154 dependency order. `verify` is the final
 * coverage gate (#178), run by the orchestrator's `runVerifyGate`, not via a `run` here.
 */
export type ReloadStageName =
  | 'releases'
  | 'lyrics'
  | 'master-data'
  | 'artist-genres'
  | 'artist-profiles'
  | 'track-versions'
  | 'mb-release-events'
  | 'track-musicbrainz'
  | 'track-acousticbrainz'
  | 'track-deezer'
  | 'nationality'
  | 'verify';

/**
 * Everything a stage needs, built once per reload. Clients whose env vars may be absent are
 * nullable; a stage that requires a null client returns `null` (recorded as `skipped`).
 * `acousticbrainz` and `deezer` builders never return null, so those stages never skip.
 */
export interface ReloadContext {
  driver: Driver;
  log: Logger;
  username: string;
  discogs: DiscogsClient | null;
  musicbrainz: MusicBrainzClient | null;
  acousticbrainz: AcousticBrainzClient;
  deezer: DeezerClient;
  wikidata: WikidataClient | null;
  viaf: VIAFClient | null;
}

export interface StageDescriptor {
  name: ReloadStageName;
  /**
   * Run the stage. Returns a flat counts map on success, or `null` to signal "skipped"
   * (a required client was not configured). A throw is caught by the orchestrator and
   * recorded as `failed` without aborting later stages.
   *
   * `onProgress` is optional: the orchestrator passes a reporter that feeds the live
   * reload-progress registry (#179); stages with no per-item loop ignore it.
   */
  run: (
    ctx: ReloadContext,
    onProgress?: ProgressReporter,
  ) => Promise<Record<string, number> | null>;
}

/**
 * The single ordered definition of the reload sequence. The orchestrator iterates this and
 * each enrich function is referenced exactly once, so there is one definition per stage.
 * Order follows #154: track-musicbrainz must precede acousticbrainz/deezer (it sets the
 * recordingMbid + isrc they depend on); acousticbrainz/deezer run sequentially here
 * (parallelising them is a future optimisation). nationality is independent.
 */
export const RELOAD_STAGES: readonly StageDescriptor[] = [
  {
    name: 'releases',
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      const s = await ingestReleases(ctx.discogs, ctx.driver, ctx.username, ctx.log, onProgress);
      return {
        releasesProcessed: s.releasesProcessed,
        releasesFailed: s.releasesFailed,
        releaseErrors: s.errors.length,
      };
    },
  },
  {
    name: 'lyrics',
    run: async (ctx, onProgress) => ({ ...(await enrichLyrics(ctx.driver, ctx.log, onProgress)) }),
  },
  {
    name: 'master-data',
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichMasterData(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'artist-genres',
    run: async (ctx) => ({ ...(await enrichArtistGenres(ctx.driver, ctx.log)) }),
  },
  {
    name: 'artist-profiles',
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichArtistProfiles(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'track-versions',
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackVersions(ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'mb-release-events',
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return { ...(await enrichMbReleaseEvents(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'track-musicbrainz',
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichTrackMusicBrainz(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)),
      };
    },
  },
  {
    name: 'track-acousticbrainz',
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackAcousticBrainz(ctx.acousticbrainz, ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'track-deezer',
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackDeezer(ctx.deezer, ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'nationality',
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichNationality(
          ctx.musicbrainz,
          ctx.driver,
          ctx.log,
          ctx.wikidata ?? undefined,
          ctx.discogs ?? undefined,
          ctx.viaf ?? undefined,
          onProgress,
        )),
      };
    },
  },
  {
    // The coverage gate (#178). Its logic lives in `runVerifyGate` in the
    // orchestrator, not here, because the gate needs to know which stages ran this
    // job (`ranStages`) — context the generic `run(ctx)` signature can't carry. This
    // descriptor stays in the sequence for ordering and job-node creation; the
    // orchestrator special-cases it and never calls this no-op `run`.
    name: 'verify',
    run: async () => Promise.resolve({}),
  },
];
