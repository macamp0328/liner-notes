import type { Driver } from 'neo4j-driver';
import type { Logger, DiscogsClient } from './discogs-client.js';
import type { MusicBrainzClient } from './musicbrainz-client.js';
import type { AcousticBrainzClient } from './acousticbrainz-client.js';
import type { DeezerClient } from './deezer-client.js';
import type { WikidataClient } from './wikidata-client.js';
import type { BreakerSource } from './circuit-breaker.js';
import type {
  ReloadContext,
  ReloadStageName,
  ReloadResource,
  StageCounts,
  StageDescriptor,
} from './stages.js';
import type { ProgressReporter } from '../enrichment/progress.js';
import { buildDiscogsClientFromEnv } from './ingest.js';
import { buildMusicBrainzClientFromEnv } from './musicbrainz-client.js';
import { buildWikidataClientFromEnv } from './wikidata-client.js';
import { buildAcousticBrainzClientFromEnv } from './acousticbrainz-client.js';
import { buildDeezerClientFromEnv } from './deezer-client.js';
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
import { enrichTrackRecordingPlaces } from '../enrichment/track-recording-places.js';
import { enrichTrackRecordingLineage } from '../enrichment/track-recording-lineage.js';
import { enrichTrackAcousticBrainz } from '../enrichment/track-acousticbrainz.js';
import { enrichTrackDeezer } from '../enrichment/track-deezer.js';
import { enrichNationality } from '../enrichment/artist-nationality.js';
import { enrichArtistMusicbrainzIds } from '../enrichment/artist-musicbrainz-id.js';
import { enrichSongwriterReconciliation } from '../enrichment/songwriter-reconciliation.js';
import { enrichArtistWikidata } from '../enrichment/artist-wikidata.js';
import { enrichArtistInfluences } from '../enrichment/artist-influences.js';
import { enrichBandMemberships } from '../enrichment/band-membership.js';
import { resetNationalityEnrichment } from '../db/artist-nationality-repository.js';
import { resetMusicbrainzIdEnrichment } from '../db/artist-musicbrainz-id-repository.js';
import { resetMbReleaseEventsEnrichment } from '../db/mb-release-events-repository.js';
import { resetTrackMusicBrainzEnrichment } from '../db/track-musicbrainz-repository.js';
import { resetTrackWorksEnrichment } from '../db/track-works-repository.js';
import { resetRecordingArtistsEnrichment } from '../db/track-recording-artists-repository.js';
import { resetRecordingPlacesEnrichment } from '../db/track-recording-places-repository.js';
import { resetRecordingLineageEnrichment } from '../db/track-recording-lineage-repository.js';
import { resetTrackAcousticBrainzEnrichment } from '../db/track-acousticbrainz-repository.js';
import { resetTrackDeezerEnrichment } from '../db/track-deezer-repository.js';
import { resetArtistProfilesEnrichment } from '../db/artist-profiles-repository.js';
import { resetArtistWikidataEnrichment } from '../db/artist-wikidata-repository.js';
import { resetLabelHierarchyEnrichment } from '../db/label-hierarchy-repository.js';
import { resetGroupMembers } from '../db/group-members-repository.js';

/**
 * The single source-of-truth definition for one enrichment stage (#477). Both the
 * orchestrated-reload descriptor (`RELOAD_STAGES` in stages.ts) and the standalone admin
 * routes (`PIPELINES` in api/admin.ts) DERIVE from this one object, so a stage is declared
 * exactly once. The two derivers used to be hand-kept in sync by a matching `name` string with
 * no validation — a typo meant a stage silently never ran (reload) or had no route (admin).
 *
 * `releases` and `verify` are reload-only bookends and stay hand-written in stages.ts: `releases`
 * runs `ingestReleases` (not an enrichment) and owns the lone `number[]` count, and `verify` is a
 * no-op coverage gate the orchestrator special-cases. So this registry covers exactly the 20
 * enrichment stages — the `EnrichmentStageName` subset.
 */
export type EnrichmentStageName = Exclude<ReloadStageName, 'releases' | 'verify'>;

/**
 * The external clients an enrichment stage may drive. `discogs`/`musicbrainz`/`wikidata` are
 * nullable (their env vars may be absent → a required-but-missing client makes a stage skip in
 * reload / 503 in admin). `acousticbrainz`/`deezer` need no token, so their `build*FromEnv` never
 * return null and they are non-nullable — those stages never skip or 503.
 *
 * `ReloadContext` is structurally a superset (adds `driver`/`log`/`username`), so the reload
 * deriver passes its `ctx` directly where a `ResolvedClients` is expected.
 */
export interface ResolvedClients {
  discogs: DiscogsClient | null;
  musicbrainz: MusicBrainzClient | null;
  wikidata: WikidataClient | null;
  acousticbrainz: AcousticBrainzClient;
  deezer: DeezerClient;
}

/**
 * The clients a stage can declare as REQUIRED via `requires` — the nullable subset of
 * {@link ResolvedClients}. `acousticbrainz`/`deezer` are deliberately excluded: they are always
 * present, so a stage can never require one, and a 503/skip can never be added to them by mistake.
 */
export type ClientKey = 'discogs' | 'musicbrainz' | 'wikidata';

/**
 * The missing-client message per required client — the single fact behind BOTH a reload "skipped"
 * (the `run` returns `null`) and an admin `503 SERVICE_UNAVAILABLE`. Wikidata's client derives its
 * User-Agent from `MUSICBRAINZ_USER_AGENT`, so its missing message names that var (preserved verbatim).
 */
export const CLIENT_REGISTRY: Record<ClientKey, { missingMessage: string }> = {
  discogs: { missingMessage: 'DISCOGS_TOKEN not configured' },
  musicbrainz: { missingMessage: 'MUSICBRAINZ_USER_AGENT not configured' },
  wikidata: { missingMessage: 'MUSICBRAINZ_USER_AGENT not configured' },
};

/**
 * Build every external client from env in one place. Reload calls this (via `buildReloadContext`)
 * and so does each admin `prepare`, so "reload and admin build identical clients" is literally one
 * code path. Every `build*FromEnv` is a pure constructor (reads env, maybe `new XClient`, no
 * logging/HTTP/throw), so building all five eagerly is observably identical to a per-stage lazy build.
 */
export function buildClientsFromEnv(log: Logger): ResolvedClients {
  return {
    discogs: buildDiscogsClientFromEnv(log),
    musicbrainz: buildMusicBrainzClientFromEnv(log),
    wikidata: buildWikidataClientFromEnv(log),
    acousticbrainz: buildAcousticBrainzClientFromEnv(log),
    deezer: buildDeezerClientFromEnv(log),
  };
}

/** A standalone-enrichment reset route's metadata + Cypher (returns the number of nodes touched). */
export interface PipelineResetConfig {
  summary: string;
  description: string;
  runningMessage: string;
  run(driver: Driver): Promise<number>;
}

/**
 * One enrichment stage, declared once. Identity + scheduling fields drive the reload descriptor;
 * the OpenAPI strings/schemas + `reset` drive the admin routes; `requires` + `enrich` drive both.
 */
export interface StageDefinition {
  name: EnrichmentStageName;

  // ── reload scheduling (consumed by stages.ts → StageDescriptor) ──
  deps: readonly ReloadStageName[];
  resources: readonly ReloadResource[];
  sources?: readonly BreakerSource[];

  /**
   * The client this stage REQUIRES (or unset for the no-client pure-Cypher / always-available-client
   * stages). The one fact behind reload-skip (`run` → `null`) and admin-503: both derivers gate on
   * `clients[requires] === null`. Optional clients a stage merely uses (nationality's wikidata/discogs)
   * are NOT declared here — the `enrich` closure forwards them with `?? undefined`.
   */
  requires?: ClientKey;

  /**
   * Run the stage. Invoked only AFTER the deriver has confirmed the `requires` client is present, so
   * it asserts that client non-null (`clients.discogs!`). The single run declaration that replaces the
   * old `StageDescriptor.run` + `PipelineEntry.prepare` pair. Reload passes a real `onProgress`; admin
   * passes none (so the enrich fn falls back to its NOOP default) — `lyrics` keys its reload-only
   * concurrency on `onProgress`'s presence.
   */
  enrich: (
    clients: ResolvedClients,
    driver: Driver,
    log: Logger,
    onProgress?: ProgressReporter,
  ) => Promise<StageCounts>;

  // ── admin routes (consumed by api/admin.ts → PipelineEntry) ──
  statusLabel: string;
  runningMessage: string;
  enrichSummary: string;
  enrichDescription: string;
  statusSummarySchema: Record<string, unknown>;
  schemaHas503: boolean;
  clientCheckFirst: boolean;
  reset?: PipelineResetConfig;
}

// ── Status (`lastResult`) summary shapes — moved verbatim from api/admin.ts. No `required`,
//    matching the original status routes. `exhausted` (#367) and `recovered` (#455) are generic-runner
//    counters only some stages emit; without them here, response serialization would strip them from
//    /admin/<stage>/status. ──

// Shared response shape for the nationality summary. Lists every field as required because
// enrichNationality fully populates the summary on every return path (including its early
// error-return). The resolvedBy* counts attribute each resolution to its chosen source.
const nationalitySummarySchema = {
  type: 'object',
  required: [
    'enriched',
    'skipped',
    'failed',
    'durationMs',
    'resolvedByMusicbrainz',
    'resolvedByWikidata',
  ],
  properties: {
    enriched: { type: 'integer', description: 'Nodes that received an ORIGIN_COUNTRY this run.' },
    skipped: {
      type: 'integer',
      description: 'Nodes no source could resolve (stamped; retried next staleness window).',
    },
    failed: { type: 'integer', description: 'Nodes that threw and were not stamped.' },
    durationMs: { type: 'integer', description: 'Wall-clock duration of the run.' },
    resolvedByMusicbrainz: {
      type: 'integer',
      description:
        'Countries this run where MusicBrainz was the chosen source (MB returned a country and Wikidata agreed or was null).',
    },
    resolvedByWikidata: {
      type: 'integer',
      description:
        'Countries this run where Wikidata was the chosen source (Wikidata-only, preferred on an MB/WD disagreement, or via the Wikipedia-URL fallback).',
    },
  },
};

const standardSummarySchema = {
  type: 'object',
  properties: {
    enriched: { type: 'integer' },
    skipped: { type: 'integer' },
    exhausted: { type: 'integer' },
    failed: { type: 'integer' },
    recovered: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const trackFeatureSummarySchema = {
  type: 'object',
  properties: {
    tracksProcessed: { type: 'integer' },
    tracksSkipped: { type: 'integer' },
    tracksFailed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

// track-acousticbrainz carries an extra `tracksExhausted` terminal-empty counter (#384) the
// throttle-only track-deezer summary lacks; without it here Fastify's serializer would strip the
// field from /admin/track-acousticbrainz/status. (A frozen source has no throttle path, so
// `tracksSkipped` is always 0 — kept for shape parity.)
const trackAcousticBrainzSummarySchema = {
  type: 'object',
  properties: {
    tracksProcessed: { type: 'integer' },
    tracksSkipped: { type: 'integer' },
    tracksExhausted: { type: 'integer' },
    tracksFailed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const mbReleaseEventsSummarySchema = {
  type: 'object',
  properties: {
    mastersProcessed: { type: 'integer' },
    mastersSkipped: { type: 'integer' },
    mastersFailed: { type: 'integer' },
    eventsWritten: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const trackMusicBrainzSummarySchema = {
  type: 'object',
  properties: {
    releasesProcessed: { type: 'integer' },
    releasesSkipped: { type: 'integer' },
    releasesFailed: { type: 'integer' },
    tracksMatched: { type: 'integer' },
    tracksUnmatched: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const trackWorksSummarySchema = {
  type: 'object',
  properties: {
    recordingsProcessed: { type: 'integer' },
    recordingsSkipped: { type: 'integer' },
    recordingsFailed: { type: 'integer' },
    worksWritten: { type: 'integer' },
    recordingOfEdges: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const trackRecordingArtistsSummarySchema = {
  type: 'object',
  properties: {
    recordingsProcessed: { type: 'integer' },
    recordingsSkipped: { type: 'integer' },
    recordingsFailed: { type: 'integer' },
    creditEdges: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const trackRecordingPlacesSummarySchema = {
  type: 'object',
  properties: {
    recordingsProcessed: { type: 'integer' },
    recordingsSkipped: { type: 'integer' },
    recordingsFailed: { type: 'integer' },
    studioEdges: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const trackRecordingLineageSummarySchema = {
  type: 'object',
  properties: {
    recordingsProcessed: { type: 'integer' },
    recordingsSkipped: { type: 'integer' },
    recordingsFailed: { type: 'integer' },
    lineageEdges: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const artistGenresSummarySchema = {
  type: 'object',
  properties: {
    genresEnriched: { type: 'integer' },
    stylesEnriched: { type: 'integer' },
    skipped: { type: 'integer' },
    failed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const personReconciliationSummarySchema = {
  type: 'object',
  properties: {
    linksReconciled: { type: 'integer' },
    failed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const songwriterReconciliationSummarySchema = {
  type: 'object',
  properties: {
    linksReconciled: { type: 'integer' },
    failed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const artistInfluencesSummarySchema = {
  type: 'object',
  properties: {
    influencedByLinks: { type: 'integer' },
    influencedByCandidates: { type: 'integer' },
    failed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

const bandMembershipSummarySchema = {
  type: 'object',
  properties: {
    membershipLinks: { type: 'integer' },
    failed: { type: 'integer' },
    durationMs: { type: 'integer' },
  },
};

/**
 * The 21 enrichment-stage definitions. **Array order = admin route registration order** (the order
 * the original hand-written PIPELINES blocks appeared): fastify-swagger emits paths in registration
 * order and the committed docs/openapi.json is a raw stringify, so reordering entries churns the
 * docs. The reload run order is a separate concern — stages.ts maps these through its own
 * `RELOAD_ORDER` (a permutation guarded by a test).
 */
export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  {
    name: 'lyrics',
    deps: ['releases'],
    resources: [],
    enrich: async (_clients, driver, log, onProgress) =>
      onProgress
        ? {
            ...(await enrichLyrics(driver, log, onProgress, undefined, {
              concurrency: resolveReloadLyricsConcurrency(),
            })),
          }
        : { ...(await enrichLyrics(driver, log)) },
    statusLabel: 'lyrics enrichment',
    runningMessage: 'Lyrics enrichment already in progress',
    enrichSummary: 'Run lyrics enrichment standalone',
    enrichDescription:
      'Enriches all Track nodes that have no lyrics yet (LRCLIB primary, Genius fallback). Blocks until complete.\n\n' +
      '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
      'Use this endpoint to re-run lyrics enrichment in isolation — e.g. after clearing Genius lyrics via ' +
      '`POST /api/v1/admin/lyrics/clear-genius`, after adding new tracks, or when LRCLIB coverage improves.\n\n' +
      '**In prod this is effectively LRCLIB-only.** The Genius fallback fires only when `GENIUS_TOKEN` is set ' +
      'AND the egress IP is not blocked. Prod leaves `GENIUS_TOKEN` unset (#258) because Genius 403s the prod ' +
      'datacenter IP regardless (#240), so the fallback self-disables there and setting the token in prod does ' +
      'NOT enable Genius. LRCLIB needs no key.\n\n' +
      'To backfill the Genius lyrics LRCLIB missed, run the operator-side residential harvest ' +
      '`pnpm lyrics:enrich:local` (see `services/graph-service/scripts/lyrics-enrich-local.ts` and ' +
      'infra/RUNBOOK.md "Harvest Genius lyrics locally"); it reuses this same pipeline from a non-blocked IP. ' +
      'When Genius does run it sends a browser-like User-Agent to clear Cloudflare (#195); override via ' +
      '`GENIUS_USER_AGENT` if the default needs refreshing.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
  },
  {
    name: 'nationality',
    deps: ['releases', 'mb-artist-id', 'track-recording-artists'],
    resources: ['discogs', 'musicbrainz', 'wikidata'],
    sources: ['musicbrainz', 'wikidata', 'discogs'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichNationality(
        clients.musicbrainz!,
        driver,
        log,
        clients.wikidata ?? undefined,
        clients.discogs ?? undefined,
        onProgress,
      )),
    }),
    statusLabel: 'nationality enrichment',
    runningMessage: 'Nationality enrichment already in progress',
    enrichSummary: 'Enrich Artist and Musician nodes with nationality (ORIGIN_COUNTRY)',
    enrichDescription:
      'Looks up country of origin for every Artist and Musician node that has not yet been enriched, ' +
      'creating `ORIGIN_COUNTRY` relationships to `Country` nodes. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually.**\n\n' +
      '**Sources (tried in order per node):**\n' +
      '1. MusicBrainz + Wikidata by Discogs ID (parallel). ' +
      'MusicBrainz uses a two-step lookup via Discogs URL → MBID → artist record. ' +
      'Wikidata uses SPARQL via P1953 → P27 → P297.\n' +
      '2. Wikidata via Wikipedia URL: fetches the Discogs artist page, extracts any English ' +
      'Wikipedia URLs from `urls[]`, and queries Wikidata via `schema:about` triple. ' +
      'Covers artists whose Discogs ID is not in Wikidata but who have a Wikipedia article. ' +
      'Requires `DISCOGS_TOKEN`.\n\n' +
      '**Conflict resolution:** when MB and WD disagree on source 1, Wikidata is preferred and the discrepancy is logged.\n\n' +
      'For musicians without a Discogs ID, MusicBrainz name search is used instead ' +
      '(score ≥ 90 only). Source 2 is skipped for these musicians.\n\n' +
      'Selects nodes that still have no `ORIGIN_COUNTRY` and whose last attempt has aged past ' +
      '`ENRICHMENT_STALENESS_DAYS` (default 30), stamping `nationalityFetchedAt` after each attempt — so a ' +
      'node no source could resolve is retried at most once per window while already-countried nodes are ' +
      'skipped. Run `POST /api/v1/admin/nationality/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: nationalitySummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset nationality enrichment markers for a full re-run',
      description:
        'Removes the `nationalityFetchedAt` property from all Artist and Musician nodes, ' +
        'causing the next `POST /api/v1/admin/nationality/enrich` call to re-process every node from scratch.\n\n' +
        'Use this when:\n' +
        '- You have added or updated enrichment sources (e.g. added Wikidata)\n' +
        '- You want to correct stale data (e.g. a known wrong country from MusicBrainz)\n' +
        '- You have new Artist or Musician nodes from a re-ingest\n\n' +
        'This endpoint is blocked while `POST /api/v1/admin/nationality/enrich` is running.',
      runningMessage:
        'Nationality enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetNationalityEnrichment(driver),
    },
  },
  {
    name: 'master-data',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    requires: 'discogs',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichMasterData(clients.discogs!, driver, log, onProgress)),
    }),
    statusLabel: 'master data enrichment',
    runningMessage: 'Master data enrichment already in progress',
    enrichSummary: 'Enrich Master nodes with global pressing countries and formats',
    enrichDescription:
      'Enrich Master nodes with global pressing countries and formats from the Discogs versions API. ' +
      'Also fetches originalYear. **This step runs automatically as part of `POST /ingest`.** ' +
      'Use this endpoint to run it in isolation without a full re-ingest. ' +
      'Deduplicates by masterDiscogsId — releases sharing the same master trigger only one API call. ' +
      'Requires `DISCOGS_TOKEN` env var.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: true,
  },
  {
    name: 'mb-release-events',
    deps: ['master-data'],
    resources: ['musicbrainz'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichMbReleaseEvents(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz release events enrichment',
    runningMessage: 'MusicBrainz release event enrichment already in progress',
    enrichSummary: 'Enrich Master nodes with MusicBrainz release events (MB_RELEASED_IN)',
    enrichDescription:
      'For each unenriched Master node, walks Discogs master ID → MusicBrainz release group → ' +
      'all official releases → release events, writing `MB_RELEASED_IN` relationships to `Country` ' +
      'nodes with ISO-3166-1 alpha-2 codes and release dates. The resolved release-group MBID is ' +
      'persisted on the Master as `musicbrainzReleaseGroupId` (provenance crosswalk, ADR 0005 law 5). ' +
      'Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually.**\n\n' +
      'Selects Master nodes that still have no `MB_RELEASED_IN` relationship and whose last attempt has ' +
      'aged past `ENRICHMENT_STALENESS_DAYS` (default 30), stamping `mbReleaseEventsFetchedAt` after each ' +
      'attempt — so a master MusicBrainz had no events for is retried at most once per window while ' +
      'already-populated masters are skipped. Run `POST /api/v1/admin/mb-release-events/reset` to force a full re-run.\n\n' +
      'Events without a country code are skipped (only ISO-coded events can be linked to Country nodes). ' +
      'Same country with different release IDs creates separate relationships, enabling `min(r.date)` ' +
      'queries for first-release-per-country.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: mbReleaseEventsSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz release event enrichment markers for a full re-run',
      description:
        'Removes the `mbReleaseEventsFetchedAt` and `musicbrainzReleaseGroupId` properties from all ' +
        'Master nodes and deletes all `MB_RELEASED_IN` relationships, causing the next ' +
        '`POST /api/v1/admin/mb-release-events/enrich` call to re-process every master from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'MusicBrainz release event enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetMbReleaseEventsEnrichment(driver),
    },
  },
  {
    name: 'track-musicbrainz',
    deps: ['releases'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackMusicBrainz(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz track enrichment',
    runningMessage: 'MusicBrainz track enrichment already in progress',
    enrichSummary: 'Enrich Track nodes with MusicBrainz recording MBID + ISRC',
    enrichDescription:
      'For each Release with unenriched tracks, resolves the MusicBrainz release via the ' +
      'Discogs URL relation, fetches its tracklist with recording IDs/ISRCs, and aligns it to ' +
      'Track nodes by validated ordinal position. Tracks left unmatched fall back to a direct ' +
      'recording search accepted only on a high MusicBrainz score. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually.**\n\n' +
      'Writes `recordingMbid` and `isrc` (both nullable) onto Track nodes — the cross-database ' +
      'identifiers downstream AcousticBrainz and Deezer enrichment depend on. Tracklist alignment ' +
      'validates title similarity and duration proximity before writing; a mismatched track is ' +
      'skipped rather than assigned a guessed MBID.\n\n' +
      'Re-selects a release while any of its tracks still has no `recordingMbid` and that track’s last ' +
      'attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30), stamping `musicBrainzFetchedAt` after ' +
      'each attempt — so a track with no MusicBrainz match is retried at most once per window while ' +
      'already-resolved tracks are skipped. Run `POST /api/v1/admin/track-musicbrainz/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: trackMusicBrainzSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz track enrichment markers for a full re-run',
      description:
        'Removes MusicBrainz fields (`musicBrainzFetchedAt`, `recordingMbid`, `isrc`) from all ' +
        'Track nodes, causing the next `POST /api/v1/admin/track-musicbrainz/enrich` call to ' +
        're-process every track from scratch.\n\n' +
        '**Cascade:** because AcousticBrainz enrichment depends on `recordingMbid` and Deezer ' +
        'enrichment depends on `isrc`, this reset also clears all AcousticBrainz fields ' +
        '(`acousticBrainzFetchedAt`, `tempo`, `musicalKey`, `musicalScale`, `loudnessDb`, ' +
        '`dynamicComplexity`, `danceabilityEstimate`, `voiceInstrumental`) and all Deezer fields ' +
        '(`deezerFetchedAt`, `deezerBpm`, `deezerGain`) from the same nodes. It also clears ' +
        'track-works (`worksFetchedAt`) and deletes every `Work` node with its `RECORDING_OF` ' +
        'edges (#336), since those are derived from `recordingMbid` too.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'MusicBrainz track enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetTrackMusicBrainzEnrichment(driver),
    },
  },
  {
    name: 'track-works',
    deps: ['track-musicbrainz'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackWorks(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz works enrichment',
    runningMessage: 'MusicBrainz works enrichment already in progress',
    enrichSummary: 'Link Track nodes to MusicBrainz Work (composition) nodes via RECORDING_OF',
    enrichDescription:
      'For each Track that carries a `recordingMbid` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
      'resolves the MusicBrainz Work(s) the recording is a performance of and writes a `RECORDING_OF` ' +
      'relationship to each `Work` node (MBID-keyed). Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, ' +
      'and only after track-musicbrainz enrichment has populated `recordingMbid`.**\n\n' +
      'Separating the composition (Work) from the recording is what makes cover/version discovery ' +
      'deterministic: two Tracks that are `RECORDING_OF` the same Work but are different recordings ' +
      'are versions/covers, while the same recording on two releases is just a duplicate — the shared ' +
      'Work MBID is the only signal, so there is no fuzzy/title matching. Each Work also captures its ' +
      'writers (composer/lyricist/writer) as provenance-tagged MusicBrainz data.\n\n' +
      'Re-selects a Track while it still has no Work (null `worksFetchedAt`) once its last attempt has ' +
      'aged past `ENRICHMENT_STALENESS_DAYS` (default 30), stamping `worksFetchedAt` after each ' +
      'attempt — so a recording MusicBrainz has no Work for is retried at most once per window. ' +
      'Run `POST /api/v1/admin/track-works/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: trackWorksSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz works enrichment for a full re-run',
      description:
        'Removes the `worksFetchedAt` marker from all Track nodes, deletes every `RECORDING_OF` ' +
        'relationship, and deletes the orphaned `Work` nodes, causing the next ' +
        '`POST /api/v1/admin/track-works/enrich` call to re-process every track from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'MusicBrainz works enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetTrackWorksEnrichment(driver),
    },
  },
  {
    name: 'track-recording-artists',
    deps: ['track-musicbrainz', 'mb-artist-id'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackRecordingArtists(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz recording-artist credit enrichment',
    runningMessage: 'MusicBrainz recording-artist credit enrichment already in progress',
    enrichSummary:
      'Push MusicBrainz recording-level performance credits down to track-scoped CREDITED_ON edges',
    enrichDescription:
      'For each Track that carries a `recordingMbid` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
      'fetches the recording’s artist relationships and writes the performer/instrument/vocal credits ' +
      'as **track-scoped** `CREDITED_ON` edges (`source: "musicbrainz"`, `scope: "track"`), increasing ' +
      'track-credit coverage from a deterministic source (#335). Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, and ' +
      'only after `track-musicbrainz` has populated `recordingMbid` AND `mb-artist-id` has resolved ' +
      'each person’s `musicbrainzId`.**\n\n' +
      'Only recording-level performance roles are pushed down; production/engineering roles (producer, ' +
      'mix, mastering, …) are correctly left release-scoped. Each performer is resolved to our nodes ' +
      'by the MusicBrainz-artist-MBID join (the `mb-artist-id` mapping, #380) — never name/title ' +
      'matching; a performer we cannot resolve gets an MBID-keyed fallback `Musician` so provenance is ' +
      'preserved, never silently merged by name.\n\n' +
      'Re-selects a Track while it still has no MB-sourced track credit (null `recordingArtistsFetchedAt`) ' +
      'once its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30), stamping ' +
      '`recordingArtistsFetchedAt` after each attempt — so a recording MusicBrainz has no performance ' +
      'relations for is retried at most once per window. Run ' +
      '`POST /api/v1/admin/track-recording-artists/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: trackRecordingArtistsSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz recording-artist credit enrichment for a full re-run',
      description:
        'Removes every MusicBrainz-sourced track credit (`CREDITED_ON` with `source: "musicbrainz"`, ' +
        '`scope: "track"`), deletes the MBID-keyed fallback `Musician` nodes this stage created ' +
        '(`musicbrainzId` set, no `discogsId`), and clears the `recordingArtistsFetchedAt` marker, ' +
        'causing the next `POST /api/v1/admin/track-recording-artists/enrich` call to re-process ' +
        'every recording from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'MusicBrainz recording-artist credit enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetRecordingArtistsEnrichment(driver),
    },
  },
  {
    name: 'track-recording-places',
    deps: ['track-musicbrainz'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackRecordingPlaces(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz recording-studio (place) enrichment',
    runningMessage: 'MusicBrainz recording-studio enrichment already in progress',
    enrichSummary:
      'Attribute MusicBrainz recording-level studios to the specific Track as RECORDED_AT edges',
    enrichDescription:
      'For each Track that carries a `recordingMbid` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
      'fetches the recording’s place relationships (`recorded at` / `mixed at`) and writes a ' +
      '**track-scoped** `(:Track)-[:RECORDED_AT {source: "musicbrainz"}]->(:Studio)` edge (#339). ' +
      'MusicBrainz models the studio at the recording level, so unlike Discogs (album-level only) this ' +
      'is a deterministic per-track studio attribution. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, and ' +
      'only after `track-musicbrainz` has populated `recordingMbid`.**\n\n' +
      'The Studio is MERGEd by its canonical `nameKey` (`toLower(trim(name))`, #443) onto the existing ' +
      'name-keyed nodes, so a track’s MusicBrainz studio lines up with the album’s Discogs studio of the ' +
      'same name — case/space variants included. The Place’s coordinates and area ' +
      'enrich the Studio node (feeding the recording-location map) via `coalesce`, so they only ever ' +
      'fill a gap.\n\n' +
      '**MusicBrainz place relations are genuinely sparse — zero studios across a collection is ' +
      'legitimate, not an error.**\n\n' +
      'Re-selects a Track while it still has no MB-sourced studio (null `recordingPlacesFetchedAt`) once ' +
      'its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30), stamping ' +
      '`recordingPlacesFetchedAt` after each attempt — so a recording MusicBrainz has no place relations ' +
      'for is retried at most once per window. Run ' +
      '`POST /api/v1/admin/track-recording-places/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: trackRecordingPlacesSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz recording-studio enrichment for a full re-run',
      description:
        'Removes every MusicBrainz-sourced track studio edge (`RECORDED_AT` with ' +
        '`source: "musicbrainz"`) and clears the `recordingPlacesFetchedAt` marker, causing the next ' +
        '`POST /api/v1/admin/track-recording-places/enrich` call to re-process every recording from ' +
        'scratch. Studio nodes — and their coordinates — are deliberately LEFT INTACT: they are facts ' +
        'about the physical studio (shared with the Discogs path) and feed the recording-location map.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'MusicBrainz recording-studio enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetRecordingPlacesEnrichment(driver),
    },
  },
  {
    name: 'track-recording-lineage',
    deps: ['track-musicbrainz'],
    resources: ['musicbrainz', 'track'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackRecordingLineage(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz recording lineage enrichment',
    runningMessage: 'MusicBrainz recording lineage enrichment already in progress',
    enrichSummary:
      'Attribute MusicBrainz recording↔recording derivative lineage to the specific Track as RELATED_RECORDING edges',
    enrichDescription:
      'For each Track that carries a `recordingMbid` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
      'fetches the recording’s `recording-rels` and writes a **track-scoped** ' +
      '`(:Track)-[:RELATED_RECORDING {source: "musicbrainz", type, direction}]->(:Recording)` edge to an ' +
      'MBID-keyed fallback `Recording` node for each curated derivative relation (#434) — `remix`, ' +
      '`DJ-mix`, `edit`, `mashes up`, `a cappella`, `instrumental`, `karaoke`, `compilation`. The ' +
      'related recording’s `type` + MB `direction` are stored RAW so the lineage is never normalised ' +
      '(and so can never be stored backwards). Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, and ' +
      'only after `track-musicbrainz` has populated `recordingMbid`.**\n\n' +
      'The fallback `Recording` node captures out-of-collection originals/derivatives; an in-collection ' +
      'counterpart resolves at query time via the `Recording.mbid → Track.recordingMbid` join (surfaced ' +
      'through `GET /api/v1/explore/lineage/:mbid`).\n\n' +
      '**MusicBrainz recording↔recording relations are genuinely sparse — zero lineage across a ' +
      'collection is legitimate, not an error.**\n\n' +
      'Re-selects a Track while it still has no MB-sourced lineage (null `recordingLineageFetchedAt`) ' +
      'once its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` (default 30), stamping ' +
      '`recordingLineageFetchedAt` after each attempt — so a recording MusicBrainz has no relations for ' +
      'is retried at most once per window. Run ' +
      '`POST /api/v1/admin/track-recording-lineage/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: trackRecordingLineageSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz recording lineage enrichment for a full re-run',
      description:
        'Removes every MusicBrainz-sourced `RELATED_RECORDING` edge (`source: "musicbrainz"`), prunes ' +
        'the now-orphaned fallback `Recording` nodes, and clears the `recordingLineageFetchedAt` ' +
        'marker, causing the next `POST /api/v1/admin/track-recording-lineage/enrich` call to ' +
        're-process every recording from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'MusicBrainz recording lineage enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetRecordingLineageEnrichment(driver),
    },
  },
  {
    name: 'track-acousticbrainz',
    deps: ['track-musicbrainz'],
    resources: ['track'],
    sources: ['acousticbrainz'],
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackAcousticBrainz(clients.acousticbrainz, driver, log, onProgress)),
    }),
    statusLabel: 'AcousticBrainz track enrichment',
    runningMessage: 'AcousticBrainz track enrichment already in progress',
    enrichSummary: 'Enrich Track nodes with AcousticBrainz audio features',
    enrichDescription:
      'For each Track that carries a `recordingMbid` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
      'fetches Essentia acoustic analysis from AcousticBrainz in bulk and writes audio-feature ' +
      'properties onto the Track node. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, ' +
      'and only after track-musicbrainz enrichment has populated `recordingMbid`.**\n\n' +
      '**Physically measured (trustworthy):** `tempo`, `musicalKey`, `musicalScale`, `loudnessDb`, ' +
      '`dynamicComplexity`.\n\n' +
      '**Model-estimated:** `danceabilityEstimate`, `voiceInstrumental` are AcousticBrainz ' +
      'classifier outputs — a different model from Spotify/Echo Nest. They are this project’s ' +
      'own estimates and must never be presented as Spotify-equivalent values. No time signature ' +
      'is provided: AcousticBrainz does not expose a reliable categorical time signature.\n\n' +
      'All fields are nullable and best-effort — AcousticBrainz coverage is crowd-sourced and ' +
      'frozen at 2022. Because the source is frozen, a recording with no usable features is ' +
      'permanent: it is marked `acousticBrainzExhausted` (counted `tracksExhausted`) and never ' +
      're-queried, rather than throttled (#384). Run `POST /api/v1/admin/track-acousticbrainz/reset` ' +
      'to force a full re-run.',
    statusSummarySchema: trackAcousticBrainzSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset AcousticBrainz track enrichment markers for a full re-run',
      description:
        'Removes the `acousticBrainzFetchedAt` marker, the terminal `acousticBrainzExhausted` ' +
        'marker, and every audio-feature property ' +
        '(`tempo`, `musicalKey`, `musicalScale`, `loudnessDb`, `dynamicComplexity`, ' +
        '`danceabilityEstimate`, `voiceInstrumental`) from all Track nodes, causing the next ' +
        '`POST /api/v1/admin/track-acousticbrainz/enrich` call to re-process every track from ' +
        'scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'AcousticBrainz track enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetTrackAcousticBrainzEnrichment(driver),
    },
  },
  {
    name: 'track-deezer',
    deps: ['track-musicbrainz'],
    resources: ['track'],
    sources: ['deezer'],
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichTrackDeezer(clients.deezer, driver, log, onProgress)),
    }),
    statusLabel: 'Deezer track enrichment',
    runningMessage: 'Deezer track enrichment already in progress',
    enrichSummary: 'Enrich Track nodes with Deezer BPM and loudness',
    enrichDescription:
      'For each Track that carries an `isrc` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
      'looks the ISRC up against the free Deezer public API and writes `deezerBpm` and ' +
      '`deezerGain` (a loudness figure) onto the Track node. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, ' +
      'and only after track-musicbrainz enrichment has populated `isrc`.**\n\n' +
      'Deezer is an independent, ISRC-keyed source. `deezerBpm`/`deezerGain` are stored under ' +
      'distinct property names rather than overwriting the AcousticBrainz `tempo`/`loudnessDb` ' +
      'fields, so the source stays traceable and the two BPM figures can be compared. Deezer ' +
      'returns `0` for unknown values — those are stored as null.\n\n' +
      'All fields are nullable and best-effort. Re-selects a track that still has no Deezer data ' +
      '(null `deezerBpm` and `deezerGain`) once its last attempt has aged past `ENRICHMENT_STALENESS_DAYS` ' +
      '(default 30), stamping `deezerFetchedAt` after each attempt — so a track Deezer had nothing for is ' +
      'retried at most once per window while already-populated tracks are skipped. Run ' +
      '`POST /api/v1/admin/track-deezer/reset` to force a full re-run.',
    statusSummarySchema: trackFeatureSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset Deezer track enrichment markers for a full re-run',
      description:
        'Removes the `deezerFetchedAt` marker and the `deezerBpm` and `deezerGain` properties ' +
        'from all Track nodes, causing the next `POST /api/v1/admin/track-deezer/enrich` call ' +
        'to re-process every track from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'Deezer track enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetTrackDeezerEnrichment(driver),
    },
  },
  {
    name: 'artist-profiles',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    requires: 'discogs',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichArtistProfiles(clients.discogs!, driver, log, onProgress)),
    }),
    statusLabel: 'artist profiles enrichment',
    runningMessage: 'Artist profiles enrichment already in progress',
    enrichSummary: 'Enrich Artist nodes with realName and profile from the Discogs artist API',
    enrichDescription:
      'For each Artist node that still has neither `realName` nor `profile` and whose last attempt ' +
      'has aged past `ENRICHMENT_STALENESS_DAYS` (default 30), fetches `GET /artists/{id}` and writes ' +
      '`realName` and `profile`, stamping `profileFetchedAt`. Blocks until complete.\n\n' +
      '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
      'Use this endpoint to run it in isolation — e.g. after adding new artists from a re-ingest. ' +
      'Artists that already have a realName or profile are skipped; one Discogs had nothing for is ' +
      'retried at most once per window via the `profileFetchedAt` marker; run ' +
      '`POST /api/v1/admin/artist-profiles/reset` first to re-fetch every artist.\n\n' +
      'Requires `DISCOGS_TOKEN` env var.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: true,
    reset: {
      summary: 'Reset artist profile enrichment markers for a full re-run',
      description:
        'Removes the `profileFetchedAt` marker and the `realName` and `profile` properties from ' +
        'all Artist nodes, causing the next `POST /api/v1/admin/artist-profiles/enrich` call to ' +
        're-fetch every artist from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'Artist profiles enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetArtistProfilesEnrichment(driver),
    },
  },
  {
    name: 'artist-genres',
    deps: ['releases'],
    resources: [],
    enrich: async (_clients, driver, log) => ({ ...(await enrichArtistGenres(driver, log)) }),
    statusLabel: 'artist genres enrichment',
    runningMessage: 'Artist genres enrichment already in progress',
    enrichSummary: 'Aggregate genres and styles from releases onto Artist nodes',
    enrichDescription:
      "Rolls each Artist's release genres/styles (via IN_GENRE and IN_STYLE) up onto the " +
      'Artist node as `genres[]` and `styles[]`. Pure graph computation — no external API. ' +
      'Blocks until complete.\n\n' +
      '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
      'Use this endpoint to recompute in isolation after a re-ingest adds releases.\n\n' +
      '**No reset endpoint:** the aggregation recomputes each Artist from scratch every run, ' +
      'so it is inherently idempotent and there is nothing to reset.',
    statusSummarySchema: artistGenresSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
  },
  {
    name: 'label-hierarchy',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    requires: 'discogs',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichLabelHierarchy(clients.discogs!, driver, log, onProgress)),
    }),
    statusLabel: 'label hierarchy enrichment',
    runningMessage: 'Label hierarchy enrichment already in progress',
    enrichSummary: 'Enrich Label nodes with their parent label from the Discogs label API',
    enrichDescription:
      'For each Label referenced by a release whose last attempt has aged past ' +
      '`ENRICHMENT_STALENESS_DAYS` (default 30), fetches `GET /labels/{id}` and records a single ' +
      '`(child)-[:PARENT_LABEL]->(parent)` edge, stamping `labelHierarchyFetchedAt`. Blocks until complete.\n\n' +
      'Only the upward `parent_label` is ingested (not `sublabels[]`): the upward edges alone connect ' +
      'every collection label in a family via their shared ancestor, which powers the ' +
      '`?includeSublabels=true` roll-up on `GET /api/v1/explore/label/:name`.\n\n' +
      'A label Discogs reports as having no parent is stamped without an edge and retried at most once ' +
      'per window; run `POST /api/v1/admin/label-hierarchy/reset` first to re-fetch every label.\n\n' +
      'Requires `DISCOGS_TOKEN` env var.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: true,
    reset: {
      summary: 'Reset label hierarchy enrichment markers for a full re-run',
      description:
        'Removes the `labelHierarchyFetchedAt` marker from all Label nodes and deletes every ' +
        'PARENT_LABEL edge, causing the next `POST /api/v1/admin/label-hierarchy/enrich` call to ' +
        're-fetch every label from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'Label hierarchy enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetLabelHierarchyEnrichment(driver),
    },
  },
  {
    name: 'group-members',
    deps: ['releases'],
    resources: ['discogs'],
    sources: ['discogs'],
    requires: 'discogs',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichGroupMembers(clients.discogs!, driver, log, onProgress)),
    }),
    statusLabel: 'group members enrichment',
    runningMessage: 'Group members enrichment already in progress',
    enrichSummary: 'Link group members via MEMBER_OF from the Discogs artist API',
    enrichDescription:
      'For each Musician node carrying a `discogsId` whose last members check has aged past ' +
      '`ENRICHMENT_STALENESS_DAYS` (default 30), fetches `GET /artists/{id}` and — when the profile ' +
      "lists members — links each member's existing Musician node to the group via " +
      '`(member)-[:MEMBER_OF { active }]->(group)`, stamping `membersFetchedAt`. Blocks until ' +
      'complete.\n\n' +
      'Group-ness is not knowable without the fetch, so every Musician-with-discogsId is checked ' +
      'once per window (non-groups are stamped and skipped). Member linking is MATCH-only — a member ' +
      'not credited anywhere in the collection has no Musician node and is skipped, never created.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually** (it ' +
      'is a full `/artists/{id}` sweep over the credited musicians). Run ' +
      '`POST /api/v1/admin/group-members/reset` first to delete every MEMBER_OF edge and re-fetch ' +
      'from scratch.\n\n' +
      'Requires `DISCOGS_TOKEN` env var.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: true,
    reset: {
      summary: 'Delete all MEMBER_OF edges and reset group-members markers for a full re-run',
      description:
        'Deletes every `MEMBER_OF` relationship and removes the `membersFetchedAt` marker from all ' +
        'Musician nodes, causing the next `POST /api/v1/admin/group-members/enrich` call to re-fetch ' +
        'every group from scratch.\n\n' +
        'This endpoint is blocked while enrichment is running.',
      runningMessage:
        'Group members enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetGroupMembers(driver),
    },
  },
  {
    name: 'person-reconciliation',
    deps: ['artist-genres', 'group-members'],
    resources: [],
    enrich: async (_clients, driver, log) => ({
      ...(await enrichPersonReconciliation(driver, log)),
    }),
    statusLabel: 'person reconciliation',
    runningMessage: 'Person reconciliation already in progress',
    enrichSummary: 'Reconcile Musician identities with Artist nodes (SAME_PERSON_AS)',
    enrichDescription:
      'Links every Musician carrying a `discogsId` to the Artist node sharing that `discogsId` via ' +
      'a `SAME_PERSON_AS` relationship. Backfills links the order-dependent inline write missed ' +
      'because the Artist node arrived via a later release. Pure graph computation — no external ' +
      'API. Idempotent and safe to re-run; picks up new collection additions without a full ' +
      're-ingest. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest`** — run it after a re-ingest, or rely ' +
      'on the orchestrated reload (`POST /api/v1/admin/reload`), which includes it.\n\n' +
      '**No reset endpoint:** the pass re-links exhaustively every run, so it is inherently ' +
      'idempotent and there is nothing to reset.',
    statusSummarySchema: personReconciliationSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
  },
  {
    name: 'mb-artist-id',
    deps: ['releases'],
    resources: ['musicbrainz'],
    sources: ['musicbrainz'],
    requires: 'musicbrainz',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichArtistMusicbrainzIds(clients.musicbrainz!, driver, log, onProgress)),
    }),
    statusLabel: 'MusicBrainz artist-ID mapping',
    runningMessage: 'MusicBrainz artist-ID mapping already in progress',
    enrichSummary: 'Resolve each Artist/Musician MusicBrainz artist MBID (musicbrainzId)',
    enrichDescription:
      'Resolves the MusicBrainz artist MBID for every Artist and Musician node carrying a ' +
      '`discogsId` (via the MusicBrainz Discogs-URL relation) and stores it as `musicbrainzId` — the ' +
      'deterministic Discogs↔MB-artist identity mapping (#380). ' +
      '`POST /api/v1/admin/songwriter-reconciliation/enrich` then joins on it to promote each ' +
      "Work's captured `writerMbids` to `(:Artist|:Musician)-[:WROTE]->(:Work)` edges — ID join " +
      'only, never name-matching.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest`** — run it after a re-ingest, or rely ' +
      'on the orchestrated reload (`POST /api/v1/admin/reload`), which includes it before ' +
      '`nationality` (which reuses the stored MBID to skip its own `/url` lookup).\n\n' +
      'Selects nodes that still have no `musicbrainzId` and whose last attempt has aged past ' +
      '`ENRICHMENT_STALENESS_DAYS` (default 30), stamping `musicbrainzIdFetchedAt` after each ' +
      'attempt — so a node MusicBrainz has no Discogs link for is retried at most once per window. ' +
      'Run `POST /api/v1/admin/mb-artist-id/reset` to force a full re-resolve.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` env var.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset MusicBrainz artist-ID mapping markers for a full re-resolve',
      description:
        'Removes the `musicbrainzId` and `musicbrainzIdFetchedAt` properties from all Artist and ' +
        'Musician nodes, causing the next `POST /api/v1/admin/mb-artist-id/enrich` call to ' +
        're-resolve every node from scratch.\n\n' +
        'This endpoint is blocked while `POST /api/v1/admin/mb-artist-id/enrich` is running.',
      runningMessage:
        'MusicBrainz artist-ID mapping is currently running — wait for it to finish before resetting',
      run: (driver) => resetMusicbrainzIdEnrichment(driver),
    },
  },
  {
    name: 'songwriter-reconciliation',
    deps: [
      'track-works',
      'mb-artist-id',
      'person-reconciliation',
      'nationality',
      'artist-wikidata',
    ],
    resources: [],
    enrich: async (_clients, driver, log) => ({
      ...(await enrichSongwriterReconciliation(driver, log)),
    }),
    statusLabel: 'songwriter reconciliation',
    runningMessage: 'Songwriter reconciliation already in progress',
    enrichSummary: 'Promote Work writers to (:Artist|:Musician)-[:WROTE]->(:Work) edges',
    enrichDescription:
      "Joins each Work's captured `writerMbids` (from #336) to the Artist/Musician nodes carrying " +
      'the matching `musicbrainzId` (resolved by `POST /api/v1/admin/mb-artist-id/enrich`) and ' +
      'MERGEs a `WROTE` edge tagged with the writer roles — ID join only, never name-matching ' +
      '(#380). No external API and **no new MusicBrainz calls**: the writer MBIDs are already on the ' +
      'Work nodes. Idempotent and safe to re-run; picks up newly-resolved MBIDs and newly-captured ' +
      'Works without a re-ingest. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest`** — run it after `mb-artist-id` (and ' +
      '`track-works`), or rely on the orchestrated reload (`POST /api/v1/admin/reload`), which ' +
      'includes it.\n\n' +
      '**No reset endpoint:** the pass re-links exhaustively every run, so it is inherently ' +
      'idempotent and there is nothing to reset.',
    statusSummarySchema: songwriterReconciliationSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
  },
  {
    name: 'artist-wikidata',
    deps: ['releases'],
    resources: ['wikidata', 'discogs'],
    sources: ['wikidata', 'discogs'],
    requires: 'wikidata',
    enrich: async (clients, driver, log, onProgress) => ({
      ...(await enrichArtistWikidata(
        clients.wikidata!,
        clients.discogs ?? undefined,
        driver,
        log,
        onProgress,
      )),
    }),
    statusLabel: 'artist Wikidata enrichment',
    runningMessage: 'Artist Wikidata enrichment already in progress',
    enrichSummary:
      'Enrich Artist nodes with Wikidata biographical data (QID, lifespan, image, awards)',
    enrichDescription:
      'Resolves each Artist node to its Wikidata item and harvests structured biographical data: ' +
      '`wikidataQid`, lifespan (`bornYear`/`bornDate`, `diedYear`/`diedDate`), `imageUrl`, and ' +
      '`awards`. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest`** — run it standalone, or rely on the ' +
      'orchestrated reload (`POST /api/v1/admin/reload`), which includes it.\n\n' +
      '**Join (deterministic, no name matching):**\n' +
      '1. Wikidata property P1953 (Discogs artist ID) → the QID, via SPARQL. Needs no Discogs call ' +
      '(the Discogs ID is already on the node).\n' +
      '2. Fallback: fetches the Discogs artist page, extracts any English Wikipedia URLs from ' +
      '`urls[]`, and resolves the Wikidata item via `schema:about`. Requires `DISCOGS_TOKEN`.\n\n' +
      'Selects Artist nodes that still have no `wikidataQid` and whose last attempt has aged past ' +
      '`ENRICHMENT_STALENESS_DAYS` (default 30), stamping `wikidataFetchedAt` after each attempt — ' +
      'so an artist Wikidata does not (yet) know is retried at most once per window while resolved ' +
      'artists are skipped. Run `POST /api/v1/admin/artist-wikidata/reset` to force a full re-run.\n\n' +
      'Requires `MUSICBRAINZ_USER_AGENT` (or `DISCOGS_USER_AGENT`) env var for the Wikidata client.',
    statusSummarySchema: standardSummarySchema,
    schemaHas503: true,
    clientCheckFirst: false,
    reset: {
      summary: 'Reset artist Wikidata enrichment markers for a full re-run',
      description:
        'Removes the `wikidataFetchedAt` marker and every Wikidata-sourced property (`wikidataQid`, ' +
        '`bornYear`/`bornDate`, `diedYear`/`diedDate`, `imageUrl`, `awards`, instruments, the ' +
        'P737 `influencedByQids` list, and the P463 `memberOfQids`/`memberOfSinceYears`/' +
        '`memberOfUntilYears` arrays) from all Artist nodes, causing the next ' +
        '`POST /api/v1/admin/artist-wikidata/enrich` call to re-resolve every node from scratch. The ' +
        'derived `INFLUENCED_BY` and wikidata `MEMBER_OF` edges are left in place — they are re-MERGEd ' +
        'exhaustively by `POST /api/v1/admin/artist-influences/enrich` and ' +
        '`POST /api/v1/admin/band-membership/enrich`.\n\n' +
        'This endpoint is blocked while `POST /api/v1/admin/artist-wikidata/enrich` is running.',
      runningMessage:
        'Artist Wikidata enrichment is currently running — wait for it to finish before resetting',
      run: (driver) => resetArtistWikidataEnrichment(driver),
    },
  },
  {
    name: 'artist-influences',
    deps: ['artist-wikidata'],
    resources: [],
    enrich: async (_clients, driver, log) => ({ ...(await enrichArtistInfluences(driver, log)) }),
    statusLabel: 'artist influence projection',
    runningMessage: 'Artist influence projection already in progress',
    enrichSummary: 'Project Wikidata P737 influences into INFLUENCED_BY edges',
    enrichDescription:
      "Resolves each Artist's captured `influencedByQids` (the raw Wikidata P737 target QIDs the " +
      '`artist-wikidata` pass stored) against the `wikidataQid` on other Artist nodes and MERGEs a ' +
      '`(:Artist)-[:INFLUENCED_BY {source:"wikidata"}]->(:Artist)` edge for each in-collection match ' +
      '(#391). Deterministic QID join — a target QID we do not own resolves to no node and is dropped ' +
      '(no name matching). No external API and **no new Wikidata calls**: the QIDs are already on the ' +
      'Artist nodes. Idempotent and safe to re-run; picks up newly-resolved targets without a ' +
      're-ingest. Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest`** — run it after `artist-wikidata`, or ' +
      'rely on the orchestrated reload (`POST /api/v1/admin/reload`), which includes it.\n\n' +
      '**No reset endpoint:** the pass re-links exhaustively every run, so it is inherently ' +
      'idempotent and there is nothing to reset (a full wipe is `POST /api/v1/admin/reset?confirm=wipe-all`).',
    statusSummarySchema: artistInfluencesSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
  },
  {
    name: 'band-membership',
    deps: ['artist-wikidata'],
    resources: [],
    enrich: async (_clients, driver, log) => ({ ...(await enrichBandMemberships(driver, log)) }),
    statusLabel: 'band membership projection',
    runningMessage: 'Band membership projection already in progress',
    enrichSummary: 'Project Wikidata P463 memberships into dated MEMBER_OF edges',
    enrichDescription:
      "Resolves each Artist's captured `memberOfQids` (the raw Wikidata P463 group QIDs the " +
      '`artist-wikidata` pass stored, with their P580/P582 begin/end years) against the `wikidataQid` ' +
      'on other Artist nodes and MERGEs a ' +
      '`(:Artist)-[:MEMBER_OF {source:"wikidata", since, until}]->(:Artist)` edge for each ' +
      'in-collection match (#392). This Artist→Artist edge is **distinct from and additive to** the ' +
      'Discogs `(:Musician)-[:MEMBER_OF {active}]->(:Musician)` edge — both survive with provenance. ' +
      'Deterministic QID join — a group QID we do not own resolves to no node and is dropped (no name ' +
      'matching). No external API and **no new Wikidata calls**: the data is already on the Artist ' +
      'nodes. Idempotent and safe to re-run; picks up newly-resolved groups without a re-ingest. ' +
      'Blocks until complete.\n\n' +
      '**This step is NOT part of `POST /api/v1/admin/ingest`** — run it after `artist-wikidata`, or ' +
      'rely on the orchestrated reload (`POST /api/v1/admin/reload`), which includes it.\n\n' +
      '**No reset endpoint:** the pass re-links exhaustively every run, so it is inherently ' +
      'idempotent and there is nothing to reset (a full wipe is `POST /api/v1/admin/reset?confirm=wipe-all`).',
    statusSummarySchema: bandMembershipSummarySchema,
    schemaHas503: false,
    clientCheckFirst: false,
  },
];

/**
 * Derive an orchestrated-reload {@link StageDescriptor} from a {@link StageDefinition}. The `run`
 * gates on the `requires` client (reading it from the shared `ctx`, a `ResolvedClients` superset)
 * and returns `null` ("skipped") when it's missing — the reload half of the single missing-client
 * fact; otherwise it delegates to `enrich`, forwarding the live `onProgress`.
 */
export function toStageDescriptor(def: StageDefinition): StageDescriptor {
  return {
    name: def.name,
    deps: def.deps,
    resources: def.resources,
    ...(def.sources !== undefined ? { sources: def.sources } : {}),
    run: async (ctx: ReloadContext, onProgress?: ProgressReporter): Promise<StageCounts | null> => {
      if (def.requires !== undefined && ctx[def.requires] === null) return null;
      return def.enrich(ctx, ctx.driver, ctx.log, onProgress);
    },
  };
}
