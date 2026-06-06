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
 * Stage names in the orchestrated reload. `verify` is the final coverage gate (#178), run by the
 * orchestrator's `runVerifyGate`, not via a `run` here.
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

/**
 * A rate-limited / contention lane a stage holds while running. Two stages sharing any resource
 * never run concurrently (see `scheduleStages`). Tags fall into two kinds:
 *
 * - `discogs` / `musicbrainz` — the shared HTTP client's rate limiter. The Discogs/MusicBrainz
 *   clients are built once and shared via `ctx`, and their limiters have no shared queue, so two
 *   concurrent stages on one client would double the request rate. Every stage that touches a
 *   client carries its tag.
 * - `track` — a Neo4j node-lock lane for **batched** Track writers. A deadlock needs two
 *   transactions that each hold-and-wait on ≥2 nodes, so it is only possible between two *batched*
 *   writers of the same label. The four batched Track writers (`track-versions`,
 *   `track-musicbrainz`, `track-acousticbrainz`, `track-deezer`) carry `track` and serialise.
 *   `lyrics` writes one Track per transaction (`setTrackLyrics`) — a single-node tx can't be half
 *   of a lock cycle, so it is deadlock-immune and intentionally untagged, free to overlap the
 *   batched Track lane. **If `lyrics` (or any per-node writer) ever moves to a batched write, give
 *   it the `track` tag.** There is no `artist` lane because `artist-genres` is the only batched
 *   Artist writer (`artist-profiles`/`nationality` write one Artist per tx), so no Artist-axis
 *   deadlock is possible.
 */
export type ReloadResource = 'discogs' | 'musicbrainz' | 'track';

export interface StageDescriptor {
  name: ReloadStageName;
  /**
   * Ordering prerequisites: this stage starts only once every dep has settled (any terminal
   * state — complete/skipped/failed), so a dep is an ordering edge, not a success gate.
   */
  deps: readonly ReloadStageName[];
  /** Mutual-exclusion lanes held while this stage runs. See {@link ReloadResource}. */
  resources: readonly ReloadResource[];
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
 * Every stage except `verify`, in priority order — when several stages are eligible for one free
 * slot the earlier one wins. Ordering is governed by `deps` (not array position), so this list is
 * tuned for *priority*: cheap + #165-gate stages (`master-data`, `artist-profiles`, the pure-Cypher
 * `artist-genres`/`track-versions`) lead, ahead of the slow `track-musicbrainz` and `lyrics`, so the
 * gate metrics reach threshold without waiting on the multi-hour stages. The list is also a valid
 * topological sort (every dep appears earlier), which keeps the persisted stage ordinals sensible.
 *
 * Dependency edges: every enrichment deps `releases` (else its candidate query runs on an empty
 * graph and marks complete, permanently missing data); `mb-release-events` deps `master-data`
 * (its candidate query `MATCH (m:Master)` needs the Master nodes only `master-data` creates);
 * `track-acousticbrainz`/`track-deezer` dep `track-musicbrainz` (they need the recordingMbid/isrc
 * it writes).
 *
 * Each `run` forwards the orchestrator's optional `onProgress` reporter to its enrich function
 * (#179); `artist-genres` has no per-item loop, so it takes none.
 */
const RELOAD_STAGES_BEFORE_VERIFY: readonly StageDescriptor[] = [
  {
    name: 'releases',
    deps: [],
    resources: ['discogs'],
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
    name: 'master-data',
    deps: ['releases'],
    resources: ['discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichMasterData(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'artist-profiles',
    deps: ['releases'],
    resources: ['discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichArtistProfiles(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'artist-genres',
    deps: ['releases'],
    resources: [],
    run: async (ctx) => ({ ...(await enrichArtistGenres(ctx.driver, ctx.log)) }),
  },
  {
    name: 'track-versions',
    deps: ['releases'],
    resources: ['track'],
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackVersions(ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'track-musicbrainz',
    deps: ['releases'],
    resources: ['musicbrainz', 'track'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichTrackMusicBrainz(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)),
      };
    },
  },
  {
    name: 'mb-release-events',
    deps: ['master-data'],
    resources: ['musicbrainz'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return { ...(await enrichMbReleaseEvents(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'lyrics',
    deps: ['releases'],
    resources: [],
    run: async (ctx, onProgress) => ({ ...(await enrichLyrics(ctx.driver, ctx.log, onProgress)) }),
  },
  {
    name: 'track-acousticbrainz',
    deps: ['track-musicbrainz'],
    resources: ['track'],
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackAcousticBrainz(ctx.acousticbrainz, ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'track-deezer',
    deps: ['track-musicbrainz'],
    resources: ['track'],
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackDeezer(ctx.deezer, ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'nationality',
    deps: ['releases'],
    resources: ['discogs', 'musicbrainz'],
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
];

/**
 * The single ordered definition of the reload sequence — the source of truth the orchestrator
 * iterates. `verify` runs strictly last: its deps are derived from every other stage, so adding a
 * stage to {@link RELOAD_STAGES_BEFORE_VERIFY} automatically keeps `verify` as the final gate.
 */
export const RELOAD_STAGES: readonly StageDescriptor[] = [
  ...RELOAD_STAGES_BEFORE_VERIFY,
  {
    // The coverage gate (#178). Its logic lives in `runVerifyGate` in the orchestrator, not here,
    // because the gate needs to know which stages ran this job (`ranStages`) — context the generic
    // `run(ctx)` signature can't carry. This descriptor stays in the sequence (its derived deps on
    // every other stage keep it strictly last) for ordering and job-node creation; the orchestrator
    // special-cases it and never calls this no-op `run`.
    name: 'verify',
    deps: RELOAD_STAGES_BEFORE_VERIFY.map((s) => s.name),
    resources: [],
    run: async () => Promise.resolve({}),
  },
];
