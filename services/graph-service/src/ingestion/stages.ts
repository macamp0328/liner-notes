import type { Driver } from 'neo4j-driver';
import type { DiscogsClient, Logger } from './discogs-client.js';
import type { MusicBrainzClient } from './musicbrainz-client.js';
import type { AcousticBrainzClient } from './acousticbrainz-client.js';
import type { DeezerClient } from './deezer-client.js';
import type { WikidataClient } from './wikidata-client.js';
import type { BreakerSource, CircuitBreakerSnapshot } from './circuit-breaker.js';
import { ingestReleases } from './ingest.js';
import { enrichLyrics, resolveReloadLyricsConcurrency } from '../enrichment/lyrics.js';
import { enrichMasterData } from '../enrichment/master-data.js';
import { enrichArtistGenres } from '../enrichment/artist-genres.js';
import { enrichArtistProfiles } from '../enrichment/artist-profiles.js';
import { enrichLabelHierarchy } from '../enrichment/label-hierarchy.js';
import { enrichGroupMembers } from '../enrichment/group-members.js';
import { enrichPersonReconciliation } from '../enrichment/person-reconciliation.js';
import { enrichMbReleaseEvents } from '../enrichment/mb-release-events.js';
import { enrichTrackMusicBrainz } from '../enrichment/track-musicbrainz.js';
import { enrichTrackWorks } from '../enrichment/track-works.js';
import { enrichTrackRecordingArtists } from '../enrichment/track-recording-artists.js';
import { enrichTrackAcousticBrainz } from '../enrichment/track-acousticbrainz.js';
import { enrichTrackDeezer } from '../enrichment/track-deezer.js';
import { enrichNationality } from '../enrichment/artist-nationality.js';
import { enrichArtistMusicbrainzIds } from '../enrichment/artist-musicbrainz-id.js';
import { enrichSongwriterReconciliation } from '../enrichment/songwriter-reconciliation.js';
import { enrichArtistWikidata } from '../enrichment/artist-wikidata.js';
import { enrichArtistInfluences } from '../enrichment/artist-influences.js';
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
  | 'track-acousticbrainz'
  | 'track-deezer'
  | 'mb-artist-id'
  | 'nationality'
  | 'songwriter-reconciliation'
  | 'artist-wikidata'
  | 'artist-influences'
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
 * Every stage except `verify`, in priority order — when several stages are eligible for one free
 * slot the earlier one wins. Ordering is governed by `deps` (not array position), so this list is
 * tuned for *priority*: cheap + #165-gate stages (`master-data`, `artist-profiles`, the pure-Cypher
 * `artist-genres`) lead, ahead of the slow `track-musicbrainz` and `lyrics`, so the
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
/**
 * Cap on the failed-release-id sample persisted to the `releases` stage counts (#417). A pathological
 * mass-failure (e.g. a Discogs outage failing the whole collection) shouldn't bloat the `ReloadStage`
 * node / `/admin/reload/status` payload; `releasesFailed` is the authoritative total, so an array
 * shorter than `releasesFailed` simply means it was truncated to this sample.
 */
const MAX_FAILED_RELEASE_IDS = 50;

const RELOAD_STAGES_BEFORE_VERIFY: readonly StageDescriptor[] = [
  {
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
  },
  {
    name: 'master-data',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichMasterData(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'artist-profiles',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
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
    name: 'label-hierarchy',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichLabelHierarchy(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    // #330: fetch /artists/{id} per Musician-with-discogsId to discover groups and write MEMBER_OF.
    // Holds the `discogs` rate-limiter lane. Its per-group write touches the group + member Musician
    // nodes (Musician axis); the only concurrent Musician multi-writer is `person-reconciliation`,
    // which deps this stage (so they never overlap) — no `track`-style node-lock lane is needed.
    name: 'group-members',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.discogs) return null;
      return { ...(await enrichGroupMembers(ctx.discogs, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    // #330: backfill SAME_PERSON_AS (Musician → Artist by shared discogsId) the order-dependent
    // inline write missed. One big MERGE tx spanning BOTH the Artist axis (endpoint) and the
    // Musician axis — the only writer that does — so it must not overlap the two single-axis batched
    // writers. `deps` order it after both (artist-genres = Artist, group-members = Musician); those
    // two touch disjoint labels and may overlap each other, so no resource lane is needed. No
    // artist-profiles dep: that stage is single-node-per-tx (deadlock-immune) and holds no data this
    // pass reads. Runs after `group-members` so its samePersonLinks coverage metric is final at verify.
    name: 'person-reconciliation',
    deps: ['artist-genres', 'group-members'],
    resources: [],
    run: async (ctx) => ({ ...(await enrichPersonReconciliation(ctx.driver, ctx.log)) }),
  },
  {
    name: 'track-musicbrainz',
    deps: ['releases'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichTrackMusicBrainz(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)),
      };
    },
  },
  {
    // #336: link each Track to the MusicBrainz Work it records, via the recordingMbid that
    // track-musicbrainz wrote (hence the dep). Holds `musicbrainz` (shared rate limiter) and
    // `track` (its batched write touches ≥2 Track nodes per tx — same deadlock class as the other
    // batched Track writers, so it serialises with them on the node-lock lane).
    name: 'track-works',
    deps: ['track-musicbrainz'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return { ...(await enrichTrackWorks(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'mb-release-events',
    deps: ['master-data'],
    resources: ['musicbrainz'],
    sources: ['musicbrainz'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return { ...(await enrichMbReleaseEvents(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)) };
    },
  },
  {
    name: 'lyrics',
    deps: ['releases'],
    resources: [],
    // Pass the reload-scoped concurrency (#372): `RELOAD_LYRICS_CONCURRENCY` lets an operator throttle
    // lyrics under the heavy concurrent reload without affecting standalone runs; unset → LYRICS_CONCURRENCY.
    run: async (ctx, onProgress) => ({
      ...(await enrichLyrics(ctx.driver, ctx.log, onProgress, undefined, {
        concurrency: resolveReloadLyricsConcurrency(),
      })),
    }),
  },
  {
    name: 'track-acousticbrainz',
    deps: ['track-musicbrainz'],
    resources: ['track'],
    sources: ['acousticbrainz'],
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackAcousticBrainz(ctx.acousticbrainz, ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    name: 'track-deezer',
    deps: ['track-musicbrainz'],
    resources: ['track'],
    sources: ['deezer'],
    run: async (ctx, onProgress) => ({
      ...(await enrichTrackDeezer(ctx.deezer, ctx.driver, ctx.log, onProgress)),
    }),
  },
  {
    // #380: resolve each Artist/Musician's MusicBrainz artist MBID (via the Discogs-URL relation)
    // and store it as `musicbrainzId` — the deterministic identity mapping the
    // `songwriter-reconciliation` pass joins on to promote Work writers to WROTE edges. Holds the
    // `musicbrainz` rate-limiter lane. Ordered before `nationality` (which deps it) so nationality
    // reuses the stored MBID and skips its own `/url` lookup — net-zero MB calls across the two for
    // resolvable nodes (mb-artist-id does the `/url`, nationality the `/artist`).
    name: 'mb-artist-id',
    deps: ['releases'],
    resources: ['musicbrainz'],
    sources: ['musicbrainz'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichArtistMusicbrainzIds(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)),
      };
    },
  },
  {
    // #335: push MusicBrainz recording-level performance credits down to the specific Track. Deps
    // BOTH track-musicbrainz (for the recordingMbid it queries) AND mb-artist-id (for the
    // musicbrainzId join that resolves each performer). Ordered after mb-artist-id so the array stays
    // a valid topological sort — running mb-artist-id first lets a performer whose Discogs↔MB link
    // resolved be reused instead of duplicated (a performer MusicBrainz has no Discogs link for still
    // gets an MBID-keyed fallback node, by design). Holds `musicbrainz` (shared rate limiter) and `track`
    // (its batched write touches ≥2 Track nodes per tx — the same deadlock class as the other batched
    // Track writers, so it serialises with them on the node-lock lane).
    name: 'track-recording-artists',
    deps: ['track-musicbrainz', 'mb-artist-id'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichTrackRecordingArtists(ctx.musicbrainz, ctx.driver, ctx.log, onProgress)),
      };
    },
  },
  {
    // #380: deps mb-artist-id so the musicbrainzId is populated first — resolveCountry then reuses
    // it (getCountryByMbid) and skips its own `/url` lookup. Both already share the `musicbrainz`
    // lane (never overlap); the dep only pins the order so the reuse actually kicks in.
    // #341: also holds the `wikidata` lane — it drives the one shared `ctx.wikidata` client, which
    // the `artist-wikidata` stage also uses, so the lane serialises that limiter across both.
    name: 'nationality',
    deps: ['releases', 'mb-artist-id'],
    resources: ['discogs', 'musicbrainz', 'wikidata'],
    sources: ['musicbrainz', 'wikidata', 'discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.musicbrainz) return null;
      return {
        ...(await enrichNationality(
          ctx.musicbrainz,
          ctx.driver,
          ctx.log,
          ctx.wikidata ?? undefined,
          ctx.discogs ?? undefined,
          onProgress,
        )),
      };
    },
  },
  {
    // #341: resolve each Artist's Wikidata QID (P1953 join, Wikipedia-URL fallback) and harvest
    // lifespan (P569/P570), image (P18), and awards (P166). Holds `wikidata` (shared rate limiter,
    // serialised with `nationality`) and `discogs` (the fallback's profile fetch — the primary
    // P1953 join uses the discogsId already on the node, so it needs no Discogs call). Writes one
    // Artist per tx, so no `track`-style node-lock lane is needed.
    name: 'artist-wikidata',
    deps: ['releases'],
    resources: ['wikidata', 'discogs'],
    sources: ['wikidata', 'discogs'],
    run: async (ctx, onProgress): Promise<Record<string, number> | null> => {
      if (!ctx.wikidata) return null;
      return {
        ...(await enrichArtistWikidata(
          ctx.wikidata,
          ctx.discogs ?? undefined,
          ctx.driver,
          ctx.log,
          onProgress,
        )),
      };
    },
  },
  {
    // #391: project each Artist's captured P737 influences (the `influencedByQids` list artist-wikidata
    // stored) into in-collection (:Artist)-[:INFLUENCED_BY {source:"wikidata"}]->(:Artist) edges,
    // resolving each target QID against `a.wikidataQid` (deterministic QID join; unowned targets are
    // dropped). Deps `artist-wikidata` so every QID is stored before resolution — creating edges inline
    // in that pass would miss any target enriched later in the same pass. Pure Cypher, no external
    // client: resources [] (ordering via deps), no `sources`.
    name: 'artist-influences',
    deps: ['artist-wikidata'],
    resources: [],
    run: async (ctx) => ({ ...(await enrichArtistInfluences(ctx.driver, ctx.log)) }),
  },
  {
    // #380: promote each Work's captured writerMbids to (:Artist|:Musician)-[:WROTE]->(:Work) edges
    // by joining on the musicbrainzId from mb-artist-id. Pure Cypher, no MB calls. Like
    // person-reconciliation it is a dual-axis writer (its two single-label MERGEs lock Artist then
    // Musician, plus Work), so it must not overlap any node writer: deps it after the two batched
    // single-axis writers (transitively via person-reconciliation, which already deps artist-genres
    // + group-members) AND after the per-node Artist writers nationality + artist-wikidata. track-
    // works + mb-artist-id supply the data it reads. Pure-Cypher + fast, so running just before
    // verify is free; resources [] — ordering via deps handles exclusion, matching person-reconciliation.
    name: 'songwriter-reconciliation',
    deps: [
      'track-works',
      'mb-artist-id',
      'person-reconciliation',
      'nationality',
      'artist-wikidata',
    ],
    resources: [],
    run: async (ctx) => ({ ...(await enrichSongwriterReconciliation(ctx.driver, ctx.log)) }),
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
