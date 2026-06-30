import type { Driver } from 'neo4j-driver';
import type { DiscogsClient, Logger } from './discogs-client.js';
import type { MusicBrainzClient } from './musicbrainz-client.js';
import type { AcousticBrainzClient } from './acousticbrainz-client.js';
import type { DeezerClient } from './deezer-client.js';
import type { WikidataClient } from './wikidata-client.js';
import type { BreakerSource, CircuitBreakerSnapshot } from './circuit-breaker.js';
import { ingestReleases } from './ingest.js';
import {
  STAGE_DEFINITIONS,
  toStageDescriptor,
  type EnrichmentStageName,
} from './stage-definitions.js';
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
  | 'label-hierarchy'
  | 'group-members'
  | 'person-reconciliation'
  | 'mb-release-events'
  | 'track-musicbrainz'
  | 'track-works'
  | 'track-recording-artists'
  | 'track-recording-places'
  | 'track-recording-lineage'
  | 'track-acousticbrainz'
  | 'track-deezer'
  | 'mb-artist-id'
  | 'nationality'
  | 'songwriter-reconciliation'
  | 'artist-wikidata'
  | 'artist-influences'
  | 'band-membership'
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
}

/**
 * A rate-limited / contention lane a stage holds while running. Two stages sharing any resource
 * never run concurrently (see `scheduleStages`). Tags fall into two kinds:
 *
 * - `discogs` / `musicbrainz` / `wikidata` — the shared HTTP client's rate limiter. Each client is
 *   built once and shared via `ctx`, and their limiters have no shared queue, so two concurrent
 *   stages on one client would double the request rate. Every stage that touches a client carries
 *   its tag — `nationality` and `artist-wikidata` both drive the one `ctx.wikidata` client, so both
 *   carry `wikidata` and never overlap.
 * - `track` — a Neo4j node-lock lane for **batched** Track writers. A deadlock needs two
 *   transactions that each hold-and-wait on ≥2 nodes, so it is only possible between two *batched*
 *   writers of the same label. The three batched Track writers (`track-musicbrainz`,
 *   `track-acousticbrainz`, `track-deezer`) carry `track` and serialise.
 *   `lyrics` writes one Track per transaction (`setTrackLyrics`) — a single-node tx can't be half
 *   of a lock cycle, so it is deadlock-immune and intentionally untagged, free to overlap the
 *   batched Track lane. **If `lyrics` (or any per-node writer) ever moves to a batched write, give
 *   it the `track` tag.** There is no `artist` lane because `artist-genres` is the only batched
 *   Artist writer (`artist-profiles`/`nationality` write one Artist per tx), so no Artist-axis
 *   deadlock is possible.
 */
export type ReloadResource = 'discogs' | 'musicbrainz' | 'wikidata' | 'track';

/**
 * A stage's persisted `counts` map. Values are numbers, with one deliberate exception: the
 * `releases` stage's `failedReleaseIds` is a bounded `number[]` (#417) — the lone non-numeric count,
 * so a non-fatal per-release failure can be identified from `/admin/reload/status`, not just counted.
 * The whole map is `JSON.stringify`d into `ReloadStage.countsJson`, so arrays persist fine.
 * (`job-repository.ts` redeclares a structurally identical local alias to avoid a db→ingestion import.)
 */
export type StageCounts = Record<string, number | number[]>;

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
   * The external `ctx`-level clients this stage drives (#242). After the stage settles, the
   * orchestrator folds each named client's circuit-breaker snapshot into the persisted `counts`
   * (`<source>BreakerOpen` 0/1, `<source>Fatals`) so a tripped source is visible in
   * `/admin/reload/status`. `genius`/`lrclib` are NOT listed here — they are run-scoped breakers
   * internal to `enrichLyrics` and surface via the lyrics stage's own summary instead.
   */
  sources?: readonly BreakerSource[];
  /**
   * Run the stage. Returns a flat counts map on success, or `null` to signal "skipped"
   * (a required client was not configured). A throw is caught by the orchestrator and
   * recorded as `failed` without aborting later stages.
   *
   * `onProgress` is optional: the orchestrator passes a reporter that feeds the live
   * reload-progress registry (#179); stages with no per-item loop ignore it.
   */
  run: (ctx: ReloadContext, onProgress?: ProgressReporter) => Promise<StageCounts | null>;
}

/**
 * Cap on the failed-release-id sample persisted to the `releases` stage counts (#417). A pathological
 * mass-failure (e.g. a Discogs outage failing the whole collection) shouldn't bloat the `ReloadStage`
 * node / `/admin/reload/status` payload; `releasesFailed` is the authoritative total, so an array
 * shorter than `releasesFailed` simply means it was truncated to this sample.
 */
const MAX_FAILED_RELEASE_IDS = 50;

/**
 * The `releases` stage stays hand-written here: it runs `ingestReleases` (the shared release
 * fetch/MERGE loop, not an enrichment) and owns the lone `number[]` count (`failedReleaseIds`,
 * #417), neither of which fits the {@link StageDefinition} enrichment contract. It is reload-only —
 * it has no standalone `/admin/*` route, so it never appears in `STAGE_DEFINITIONS`.
 */
const RELEASES_DESCRIPTOR: StageDescriptor = {
  name: 'releases',
  deps: [],
  resources: ['discogs'],
  sources: ['discogs'],
  run: async (ctx, onProgress): Promise<StageCounts | null> => {
    if (!ctx.discogs) return null;
    const s = await ingestReleases(ctx.discogs, ctx.driver, ctx.username, ctx.log, onProgress);
    return {
      releasesProcessed: s.releasesProcessed,
      releasesFailed: s.releasesFailed,
      releaseErrors: s.errors.length,
      // Surface *which* releases failed (#417), bounded — omitted entirely on a clean reload.
      ...(s.failedReleaseIds.length > 0
        ? { failedReleaseIds: s.failedReleaseIds.slice(0, MAX_FAILED_RELEASE_IDS) }
        : {}),
    };
  },
};

/**
 * The 21 enrichment stages in reload **priority** order — when several are eligible for one free
 * slot the earlier one wins. Ordering at runtime is governed by each stage's `deps` (declared on its
 * {@link StageDefinition}), not array position, so this list is tuned for priority: cheap + #165-gate
 * stages (`master-data`, `artist-profiles`, the pure-Cypher `artist-genres`) lead, ahead of the slow
 * `track-musicbrainz` and `lyrics`, so the gate metrics reach threshold without waiting on the
 * multi-hour stages. It is also a valid topological sort (every dep appears earlier), which keeps the
 * persisted stage ordinals sensible.
 *
 * This is a **permutation** of {@link STAGE_DEFINITIONS} (which is in admin-route registration order,
 * a separate concern) — a unit test asserts the two stay in lockstep, so a stage added to the registry
 * without a slot here (or vice versa) fails at test time. Dependency edges and resource lanes live on
 * each `StageDefinition`, not here.
 */
const RELOAD_ORDER: readonly EnrichmentStageName[] = [
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
  'mb-artist-id',
  'track-recording-artists',
  'track-recording-places',
  'track-recording-lineage',
  'nationality',
  'artist-wikidata',
  'artist-influences',
  'band-membership',
  'songwriter-reconciliation',
];

const STAGE_DEFINITION_BY_NAME = new Map(STAGE_DEFINITIONS.map((def) => [def.name, def]));

/**
 * Every stage except `verify`: the hand-written `releases` bookend followed by the 21 enrichment
 * stages, each derived from its single {@link StageDefinition} via {@link toStageDescriptor}.
 */
const RELOAD_STAGES_BEFORE_VERIFY: readonly StageDescriptor[] = [
  RELEASES_DESCRIPTOR,
  ...RELOAD_ORDER.map((name): StageDescriptor => {
    const def = STAGE_DEFINITION_BY_NAME.get(name);
    if (def === undefined) throw new Error(`RELOAD_ORDER names unknown enrichment stage: ${name}`);
    return toStageDescriptor(def);
  }),
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

/**
 * Read a `ctx`-level client's circuit-breaker snapshot by source key (#242). Returns null for a
 * source with no live client (an unconfigured nullable client, or `genius`/`lrclib`, which are not
 * `ctx` clients). A `switch` over the fixed union keeps this free of dynamic object indexing.
 */
export function clientBreakerSnapshot(
  ctx: ReloadContext,
  source: BreakerSource,
): CircuitBreakerSnapshot | null {
  switch (source) {
    case 'discogs':
      return ctx.discogs?.breakerSnapshot() ?? null;
    case 'musicbrainz':
      return ctx.musicbrainz?.breakerSnapshot() ?? null;
    case 'acousticbrainz':
      return ctx.acousticbrainz.breakerSnapshot();
    case 'deezer':
      return ctx.deezer.breakerSnapshot();
    case 'wikidata':
      return ctx.wikidata?.breakerSnapshot() ?? null;
    case 'genius':
    case 'lrclib':
      return null;
  }
}

/**
 * Fold a stage's declared sources' breaker snapshots into its persisted `counts` so a tripped
 * source surfaces in `/admin/reload/status`. Returns the same `counts` object for chaining.
 */
export function foldBreakerCounts(
  ctx: ReloadContext,
  descriptor: StageDescriptor,
  counts: StageCounts,
): StageCounts {
  for (const source of descriptor.sources ?? []) {
    const snap = clientBreakerSnapshot(ctx, source);
    if (snap === null) continue;
    Object.assign(counts, {
      [`${source}BreakerOpen`]: snap.open ? 1 : 0,
      [`${source}Fatals`]: snap.fatalCount,
    });
  }
  return counts;
}
