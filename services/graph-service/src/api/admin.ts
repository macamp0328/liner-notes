import type { FastifyInstance } from 'fastify';
import { adminAuthHook } from './middleware/admin-auth.js';
import { getDriver } from '../db/client.js';
import { wipeGraph } from '../db/ingestion-repository.js';
import { buildDiscogsClientFromEnv, runIngestion } from '../ingestion/ingest.js';
import {
  getJobState,
  startJob,
  completeJob,
  failJob,
  type IngestionStats,
} from '../ingestion/job-state.js';
import { clearGeniusLyrics } from '../db/lyrics-repository.js';
import { enrichLyrics } from '../enrichment/lyrics.js';
import { buildMusicBrainzClientFromEnv } from '../ingestion/musicbrainz-client.js';
import { buildWikidataClientFromEnv } from '../ingestion/wikidata-client.js';
import { buildViafClientFromEnv } from '../ingestion/viaf-client.js';
import { enrichNationality } from '../enrichment/artist-nationality.js';
import { resetNationalityEnrichment } from '../db/artist-nationality-repository.js';
import { enrichMasterData } from '../enrichment/master-data.js';
import { enrichMbReleaseEvents } from '../enrichment/mb-release-events.js';
import { resetMbReleaseEventsEnrichment } from '../db/mb-release-events-repository.js';
import { enrichTrackMusicBrainz } from '../enrichment/track-musicbrainz.js';
import { resetTrackMusicBrainzEnrichment } from '../db/track-musicbrainz-repository.js';
import { buildAcousticBrainzClientFromEnv } from '../ingestion/acousticbrainz-client.js';
import { enrichTrackAcousticBrainz } from '../enrichment/track-acousticbrainz.js';
import { resetTrackAcousticBrainzEnrichment } from '../db/track-acousticbrainz-repository.js';
import { buildDeezerClientFromEnv } from '../ingestion/deezer-client.js';
import { enrichTrackDeezer } from '../enrichment/track-deezer.js';
import { resetTrackDeezerEnrichment } from '../db/track-deezer-repository.js';
import { enrichArtistProfiles } from '../enrichment/artist-profiles.js';
import { resetArtistProfilesEnrichment } from '../db/artist-profiles-repository.js';
import { enrichArtistGenres } from '../enrichment/artist-genres.js';
import { enrichTrackVersions } from '../enrichment/track-versions.js';
import { resetTrackVersions } from '../db/track-versions-repository.js';

const errorShape = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const statsShape = {
  type: 'object',
  nullable: true,
  properties: {
    nodes: { type: 'object', additionalProperties: { type: 'number' } },
    relationships: { type: 'object', additionalProperties: { type: 'number' } },
    lyricsEnriched: { type: 'number' },
    lyricsSkipped: { type: 'number' },
    lyricsFailed: { type: 'number' },
    errorCount: { type: 'number' },
    errors: { type: 'array', items: { type: 'string' } },
  },
} as const;

const jobStateShape = {
  type: 'object',
  required: ['status', 'jobId'],
  properties: {
    status: { type: 'string', enum: ['idle', 'running', 'complete', 'failed'] },
    jobId: { type: 'string' },
    startedAt: { type: 'string', nullable: true },
    completedAt: { type: 'string', nullable: true },
    durationMs: { type: 'number', nullable: true },
    stats: statsShape,
  },
} as const;

interface PipelineState<T> {
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  lastResult: T | null;
}

function makePipelineState<T>(): PipelineState<T> {
  return { running: false, startedAt: null, completedAt: null, durationMs: null, lastResult: null };
}

type EnrichSummary = { enriched: number; skipped: number; failed: number; durationMs: number };
type MbReleaseEventsSummary = {
  mastersProcessed: number;
  mastersSkipped: number;
  mastersFailed: number;
  eventsWritten: number;
  durationMs: number;
};
type TrackMusicBrainzSummary = {
  releasesProcessed: number;
  releasesSkipped: number;
  releasesFailed: number;
  tracksMatched: number;
  tracksUnmatched: number;
  durationMs: number;
};
type TrackAcousticBrainzSummary = {
  tracksProcessed: number;
  tracksSkipped: number;
  tracksFailed: number;
  durationMs: number;
};
type TrackDeezerSummary = {
  tracksProcessed: number;
  tracksSkipped: number;
  tracksFailed: number;
  durationMs: number;
};
type ArtistGenresSummary = {
  genresEnriched: number;
  stylesEnriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
};

const lyricsState = makePipelineState<EnrichSummary>();
const nationalityState = makePipelineState<EnrichSummary>();
const masterDataState = makePipelineState<EnrichSummary>();
const mbReleaseEventsState = makePipelineState<MbReleaseEventsSummary>();
const trackMusicBrainzState = makePipelineState<TrackMusicBrainzSummary>();
const trackAcousticBrainzState = makePipelineState<TrackAcousticBrainzSummary>();
const trackDeezerState = makePipelineState<TrackDeezerSummary>();
const artistProfilesState = makePipelineState<EnrichSummary>();
const artistGenresState = makePipelineState<ArtistGenresSummary>();
const trackVersionsState = makePipelineState<EnrichSummary>();

// eslint-disable-next-line @typescript-eslint/require-await
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Reply:
      | { data: { jobId: string; message: string } }
      | { error: { code: string; message: string; jobId?: string } };
  }>(
    '/ingest',
    {
      schema: {
        tags: ['admin'],
        summary: 'Trigger the full Discogs → Neo4j ingestion pipeline',
        description:
          'Runs asynchronously — returns 202 immediately and processes in the background.\n\n' +
          '**Steps run automatically:**\n' +
          '1. Fetch & MERGE all releases from the Discogs collection\n' +
          '2. Lyrics enrichment (LRCLIB primary, Genius fallback)\n' +
          '3. Master data enrichment (originalYear + global pressing countries/formats via Discogs master API)\n' +
          '4. Artist genres/styles aggregation (rolled up from releases)\n' +
          '5. Track version deduplication (IS_VERSION_OF relationships)\n' +
          '6. Artist profiles enrichment (realName + profile from Discogs artist API)\n\n' +
          '**Not included — must be triggered separately:**\n' +
          '- `POST /api/v1/admin/nationality/enrich` — nationality data from MusicBrainz + Wikidata\n' +
          '- `POST /api/v1/admin/mb-release-events/enrich` — ISO-coded country + date release events from MusicBrainz\n' +
          '- `POST /api/v1/admin/track-musicbrainz/enrich` — recording MBID + ISRC on Track nodes from MusicBrainz\n' +
          '- `POST /api/v1/admin/track-acousticbrainz/enrich` — tempo/key/loudness audio features on Track nodes from AcousticBrainz\n' +
          '- `POST /api/v1/admin/track-deezer/enrich` — BPM + loudness on Track nodes from Deezer (ISRC lookup)',
        security: [{ bearerAuth: [] }],
        response: {
          202: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['jobId', 'message'],
                properties: {
                  jobId: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          401: errorShape,
          409: {
            type: 'object',
            required: ['error'],
            properties: {
              error: {
                type: 'object',
                required: ['code', 'message', 'jobId'],
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  jobId: { type: 'string' },
                },
              },
            },
          },
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      const current = getJobState();
      if (current.status === 'running') {
        return reply.code(409).send({
          error: {
            code: 'JOB_RUNNING',
            message: 'Ingestion already in progress',
            jobId: current.jobId,
          },
        });
      }

      const username = process.env['DISCOGS_USERNAME'];
      const discogsClient = buildDiscogsClientFromEnv(request.log);

      if (!discogsClient || !username) {
        request.log.warn(
          'POST /ingest: DISCOGS_TOKEN or DISCOGS_USERNAME not set — cannot trigger ingestion',
        );
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Discogs credentials not configured',
          },
        });
      }

      const jobId = startJob();
      const driver = getDriver();

      void runIngestion(discogsClient, driver, { username, logger: request.log })
        .then((summary) => {
          const stats: IngestionStats = {
            nodes: {},
            relationships: {},
            lyricsEnriched: summary.lyricsEnrichment.enriched,
            lyricsSkipped: summary.lyricsEnrichment.skipped,
            lyricsFailed: summary.lyricsEnrichment.failed,
            errorCount: summary.errors.length,
            errors: summary.errors.slice(0, 50),
          };
          completeJob(stats);
        })
        .catch((err: unknown) => {
          failJob(err instanceof Error ? err.message : String(err));
        });

      return reply.code(202).send({ data: { jobId, message: 'Ingestion started' } });
    },
  );

  fastify.get<{ Reply: { data: ReturnType<typeof getJobState> } }>(
    '/ingest/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get the status of the current or last ingestion job',
        description:
          'Returns the job state for the ingestion triggered by `POST /api/v1/admin/ingest`. ' +
          'Status values: `idle` (never run), `running`, `complete`, `failed`. ' +
          'Does not reflect the status of standalone enrichment endpoints (`/api/v1/admin/lyrics/enrich`, `/api/v1/admin/nationality/enrich`).',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: jobStateShape,
            },
          },
          401: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      return reply.send({ data: getJobState() });
    },
  );

  fastify.post<{
    Querystring: { confirm?: string };
    Reply: { data: { deleted: number } } | { error: { code: string; message: string } };
  }>(
    '/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Wipe the entire graph (destructive)',
        description:
          '**Deletes ALL nodes and relationships** via `MATCH (n) DETACH DELETE n`. ' +
          'Intended for a deliberate "wipe and reload from scratch" — the graph is fully ' +
          'reconstructable from Discogs, so there is no separate backup to restore.\n\n' +
          'Double-gated: requires the `ADMIN_TOKEN` bearer **and** an explicit `?confirm=wipe-all` ' +
          'query parameter. Without the exact confirm value it returns 400 and changes nothing.\n\n' +
          'After wiping, restart the pod (or call `POST /api/v1/admin/ingest`) to re-ingest: an empty ' +
          'graph auto-triggers ingestion on startup.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            confirm: { type: 'string', description: 'Must equal "wipe-all" to proceed.' },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['deleted'],
                properties: { deleted: { type: 'integer' } },
              },
            },
          },
          400: errorShape,
          401: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (request.query.confirm !== 'wipe-all') {
        return reply.code(400).send({
          error: {
            code: 'CONFIRMATION_REQUIRED',
            message: 'Refusing to wipe the graph without ?confirm=wipe-all',
          },
        });
      }
      const deleted = await wipeGraph(getDriver());
      // Log at error level (Pino 50) so this destructive action trips the
      // CloudWatch error metric filter (`$.data.level >= 50`) — a graph wipe is
      // rare and high-impact enough to warrant surfacing as an alertable event.
      request.log.error(`[admin] Graph wiped via POST /reset — ${deleted} nodes deleted`);
      return reply.send({ data: { deleted } });
    },
  );

  fastify.post<{
    Reply: { data: { cleared: number } } | { error: { code: string; message: string } };
  }>(
    '/lyrics/clear-genius',
    {
      schema: {
        tags: ['admin'],
        summary: 'Clear all Genius-sourced lyrics for re-enrichment',
        description:
          'Sets `lyrics` and `lyricsSource` to null on every Track node where `lyricsSource = "genius"`. ' +
          'Those tracks will be picked up on the next lyrics enrichment pass.\n\n' +
          'Use this when Genius data quality is poor or after correcting the Genius token. ' +
          'After clearing, trigger re-enrichment via `POST /api/v1/admin/lyrics/enrich` or `POST /api/v1/admin/ingest`.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['cleared'],
                properties: { cleared: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      const cleared = await clearGeniusLyrics(getDriver());
      return reply.send({ data: { cleared } });
    },
  );

  fastify.post<{
    Reply:
      | { data: { enriched: number; skipped: number; failed: number; durationMs: number } }
      | { error: { code: string; message: string } };
  }>(
    '/lyrics/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Run lyrics enrichment standalone',
        description:
          'Enriches all Track nodes that have no lyrics yet (LRCLIB primary, Genius fallback). Blocks until complete.\n\n' +
          '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
          'Use this endpoint to re-run lyrics enrichment in isolation — e.g. after clearing Genius lyrics via ' +
          '`POST /api/v1/admin/lyrics/clear-genius`, after adding new tracks, or when LRCLIB coverage improves.\n\n' +
          'Requires `GENIUS_TOKEN` env var for the Genius fallback; LRCLIB works without any key.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['enriched', 'skipped', 'failed', 'durationMs'],
                properties: {
                  enriched: { type: 'integer' },
                  skipped: { type: 'integer' },
                  failed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (lyricsState.running) {
        return reply.code(409).send({
          error: { code: 'ENRICHMENT_RUNNING', message: 'Lyrics enrichment already in progress' },
        });
      }
      lyricsState.running = true;
      lyricsState.startedAt = new Date().toISOString();
      lyricsState.completedAt = null;
      lyricsState.durationMs = null;
      lyricsState.lastResult = null;
      try {
        const summary = await enrichLyrics(getDriver(), request.log);
        lyricsState.lastResult = summary;
        lyricsState.completedAt = new Date().toISOString();
        lyricsState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        lyricsState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | { data: { enriched: number; skipped: number; failed: number; durationMs: number } }
      | { error: { code: string; message: string } };
  }>(
    '/nationality/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Artist and Musician nodes with nationality (ORIGIN_COUNTRY)',
        description:
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
          'Requires `DISCOGS_TOKEN`.\n' +
          '3. VIAF name search: queries the Virtual International Authority File by artist name. ' +
          'Strong coverage of classical/orchestral musicians. Validates nameType, name match, ' +
          'and nationality agreement before accepting. Requires `MUSICBRAINZ_USER_AGENT`.\n\n' +
          '**Conflict resolution:** when MB and WD disagree on source 1, Wikidata is preferred and the discrepancy is logged.\n\n' +
          'For musicians without a Discogs ID, MusicBrainz name search is used instead ' +
          '(score ≥ 90 only). Sources 2 and 3 are skipped for these musicians.\n\n' +
          'Uses `nationalityFetched = true` as an idempotency marker — already-processed nodes are skipped. ' +
          'Run `POST /api/v1/admin/nationality/reset` first to re-process all nodes with updated source data.\n\n' +
          'Requires `MUSICBRAINZ_USER_AGENT` env var.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['enriched', 'skipped', 'failed', 'durationMs'],
                properties: {
                  enriched: { type: 'integer' },
                  skipped: { type: 'integer' },
                  failed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (nationalityState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Nationality enrichment already in progress',
          },
        });
      }

      const mbClient = buildMusicBrainzClientFromEnv(request.log);
      if (!mbClient) {
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'MUSICBRAINZ_USER_AGENT not configured',
          },
        });
      }

      const wdClient = buildWikidataClientFromEnv(request.log);
      const discogsClient = buildDiscogsClientFromEnv(request.log);
      const viafClient = buildViafClientFromEnv(request.log);

      nationalityState.running = true;
      nationalityState.startedAt = new Date().toISOString();
      nationalityState.completedAt = null;
      nationalityState.durationMs = null;
      nationalityState.lastResult = null;
      try {
        const summary = await enrichNationality(
          mbClient,
          getDriver(),
          request.log,
          wdClient ?? undefined,
          discogsClient ?? undefined,
          viafClient ?? undefined,
        );
        nationalityState.lastResult = summary;
        nationalityState.completedAt = new Date().toISOString();
        nationalityState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        nationalityState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/nationality/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reset nationality enrichment markers for a full re-run',
        description:
          'Removes the `nationalityFetched` property from all Artist and Musician nodes, ' +
          'causing the next `POST /api/v1/admin/nationality/enrich` call to re-process every node from scratch.\n\n' +
          'Use this when:\n' +
          '- You have added or updated enrichment sources (e.g. added Wikidata)\n' +
          '- You want to correct stale data (e.g. a known wrong country from MusicBrainz)\n' +
          '- You have new Artist or Musician nodes from a re-ingest\n\n' +
          'This endpoint is blocked while `POST /api/v1/admin/nationality/enrich` is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (nationalityState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'Nationality enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      const reset = await resetNationalityEnrichment(getDriver());
      return reply.send({ data: { reset } });
    },
  );

  fastify.post<{
    Reply:
      | { data: { enriched: number; skipped: number; failed: number; durationMs: number } }
      | { error: { code: string; message: string } };
  }>(
    '/master-data/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Master nodes with global pressing countries and formats',
        description:
          'Enrich Master nodes with global pressing countries and formats from the Discogs versions API. ' +
          'Also fetches originalYear. **This step runs automatically as part of `POST /ingest`.** ' +
          'Use this endpoint to run it in isolation without a full re-ingest. ' +
          'Deduplicates by masterDiscogsId — releases sharing the same master trigger only one API call. ' +
          'Requires `DISCOGS_TOKEN` env var.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['enriched', 'skipped', 'failed', 'durationMs'],
                properties: {
                  enriched: { type: 'integer' },
                  skipped: { type: 'integer' },
                  failed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      const discogsClient = buildDiscogsClientFromEnv(request.log);
      if (!discogsClient) {
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'DISCOGS_TOKEN not configured',
          },
        });
      }

      if (masterDataState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Master data enrichment already in progress',
          },
        });
      }

      masterDataState.running = true;
      masterDataState.startedAt = new Date().toISOString();
      masterDataState.completedAt = null;
      masterDataState.durationMs = null;
      masterDataState.lastResult = null;
      try {
        const summary = await enrichMasterData(discogsClient, getDriver(), request.log);
        masterDataState.lastResult = summary;
        masterDataState.completedAt = new Date().toISOString();
        masterDataState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        masterDataState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | {
          data: {
            mastersProcessed: number;
            mastersSkipped: number;
            mastersFailed: number;
            eventsWritten: number;
            durationMs: number;
          };
        }
      | { error: { code: string; message: string } };
  }>(
    '/mb-release-events/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Master nodes with MusicBrainz release events (MB_RELEASED_IN)',
        description:
          'For each unenriched Master node, walks Discogs master ID → MusicBrainz release group → ' +
          'all official releases → release events, writing `MB_RELEASED_IN` relationships to `Country` ' +
          'nodes with ISO-3166-1 alpha-2 codes and release dates. Blocks until complete.\n\n' +
          '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually.**\n\n' +
          'Uses `mbReleaseEventsFetched = true` as an idempotency marker — already-processed Master nodes ' +
          'are skipped. Run `POST /api/v1/admin/mb-release-events/reset` first to re-process all nodes.\n\n' +
          'Events without a country code are skipped (only ISO-coded events can be linked to Country nodes). ' +
          'Same country with different release IDs creates separate relationships, enabling `min(r.date)` ' +
          'queries for first-release-per-country.\n\n' +
          'Requires `MUSICBRAINZ_USER_AGENT` env var.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: [
                  'mastersProcessed',
                  'mastersSkipped',
                  'mastersFailed',
                  'eventsWritten',
                  'durationMs',
                ],
                properties: {
                  mastersProcessed: { type: 'integer' },
                  mastersSkipped: { type: 'integer' },
                  mastersFailed: { type: 'integer' },
                  eventsWritten: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (mbReleaseEventsState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'MusicBrainz release event enrichment already in progress',
          },
        });
      }

      const mbClient = buildMusicBrainzClientFromEnv(request.log);
      if (!mbClient) {
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'MUSICBRAINZ_USER_AGENT not configured',
          },
        });
      }

      mbReleaseEventsState.running = true;
      mbReleaseEventsState.startedAt = new Date().toISOString();
      mbReleaseEventsState.completedAt = null;
      mbReleaseEventsState.durationMs = null;
      mbReleaseEventsState.lastResult = null;
      try {
        const summary = await enrichMbReleaseEvents(mbClient, getDriver(), request.log);
        mbReleaseEventsState.lastResult = summary;
        mbReleaseEventsState.completedAt = new Date().toISOString();
        mbReleaseEventsState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        mbReleaseEventsState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/mb-release-events/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reset MusicBrainz release event enrichment markers for a full re-run',
        description:
          'Removes the `mbReleaseEventsFetched` property from all Master nodes and deletes all ' +
          '`MB_RELEASED_IN` relationships, causing the next ' +
          '`POST /api/v1/admin/mb-release-events/enrich` call to re-process every master from scratch.\n\n' +
          'This endpoint is blocked while enrichment is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (mbReleaseEventsState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'MusicBrainz release event enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      mbReleaseEventsState.running = true;
      try {
        const reset = await resetMbReleaseEventsEnrichment(getDriver());
        return reply.send({ data: { reset } });
      } finally {
        mbReleaseEventsState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | {
          data: {
            releasesProcessed: number;
            releasesSkipped: number;
            releasesFailed: number;
            tracksMatched: number;
            tracksUnmatched: number;
            durationMs: number;
          };
        }
      | { error: { code: string; message: string } };
  }>(
    '/track-musicbrainz/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Track nodes with MusicBrainz recording MBID + ISRC',
        description:
          'For each Release with unenriched tracks, resolves the MusicBrainz release via the ' +
          'Discogs URL relation, fetches its tracklist with recording IDs/ISRCs, and aligns it to ' +
          'Track nodes by validated ordinal position. Tracks left unmatched fall back to a direct ' +
          'recording search accepted only on a high MusicBrainz score. Blocks until complete.\n\n' +
          '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually.**\n\n' +
          'Writes `recordingMbid` and `isrc` (both nullable) onto Track nodes — the cross-database ' +
          'identifiers downstream AcousticBrainz and Deezer enrichment depend on. Tracklist alignment ' +
          'validates title similarity and duration proximity before writing; a mismatched track is ' +
          'skipped rather than assigned a guessed MBID.\n\n' +
          'Uses `musicBrainzFetched = true` as an idempotency marker — already-processed Track nodes ' +
          'are skipped. Run `POST /api/v1/admin/track-musicbrainz/reset` first to re-process all tracks.\n\n' +
          'Requires `MUSICBRAINZ_USER_AGENT` env var.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: [
                  'releasesProcessed',
                  'releasesSkipped',
                  'releasesFailed',
                  'tracksMatched',
                  'tracksUnmatched',
                  'durationMs',
                ],
                properties: {
                  releasesProcessed: { type: 'integer' },
                  releasesSkipped: { type: 'integer' },
                  releasesFailed: { type: 'integer' },
                  tracksMatched: { type: 'integer' },
                  tracksUnmatched: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (trackMusicBrainzState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'MusicBrainz track enrichment already in progress',
          },
        });
      }

      const mbClient = buildMusicBrainzClientFromEnv(request.log);
      if (!mbClient) {
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'MUSICBRAINZ_USER_AGENT not configured',
          },
        });
      }

      trackMusicBrainzState.running = true;
      trackMusicBrainzState.startedAt = new Date().toISOString();
      trackMusicBrainzState.completedAt = null;
      trackMusicBrainzState.durationMs = null;
      trackMusicBrainzState.lastResult = null;
      try {
        const summary = await enrichTrackMusicBrainz(mbClient, getDriver(), request.log);
        trackMusicBrainzState.lastResult = summary;
        trackMusicBrainzState.completedAt = new Date().toISOString();
        trackMusicBrainzState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        trackMusicBrainzState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/track-musicbrainz/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reset MusicBrainz track enrichment markers for a full re-run',
        description:
          'Removes MusicBrainz fields (`musicBrainzFetched`, `recordingMbid`, `isrc`) from all ' +
          'Track nodes, causing the next `POST /api/v1/admin/track-musicbrainz/enrich` call to ' +
          're-process every track from scratch.\n\n' +
          '**Cascade:** because AcousticBrainz enrichment depends on `recordingMbid` and Deezer ' +
          'enrichment depends on `isrc`, this reset also clears all AcousticBrainz fields ' +
          '(`acousticBrainzFetched`, `tempo`, `musicalKey`, `musicalScale`, `loudnessDb`, ' +
          '`dynamicComplexity`, `danceabilityEstimate`, `voiceInstrumental`) and all Deezer fields ' +
          '(`deezerFetched`, `deezerBpm`, `deezerGain`) from the same nodes.\n\n' +
          'This endpoint is blocked while enrichment is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (trackMusicBrainzState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'MusicBrainz track enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      trackMusicBrainzState.running = true;
      try {
        const reset = await resetTrackMusicBrainzEnrichment(getDriver());
        return reply.send({ data: { reset } });
      } finally {
        trackMusicBrainzState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | {
          data: {
            tracksProcessed: number;
            tracksSkipped: number;
            tracksFailed: number;
            durationMs: number;
          };
        }
      | { error: { code: string; message: string } };
  }>(
    '/track-acousticbrainz/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Track nodes with AcousticBrainz audio features',
        description:
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
          'frozen at 2022. Uses `acousticBrainzFetched = true` as an idempotency marker; ' +
          'already-processed Track nodes are skipped. Run `POST /api/v1/admin/track-acousticbrainz/reset` ' +
          'first to re-process all tracks.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['tracksProcessed', 'tracksSkipped', 'tracksFailed', 'durationMs'],
                properties: {
                  tracksProcessed: { type: 'integer' },
                  tracksSkipped: { type: 'integer' },
                  tracksFailed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (trackAcousticBrainzState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'AcousticBrainz track enrichment already in progress',
          },
        });
      }

      const abClient = buildAcousticBrainzClientFromEnv(request.log);

      trackAcousticBrainzState.running = true;
      trackAcousticBrainzState.startedAt = new Date().toISOString();
      trackAcousticBrainzState.completedAt = null;
      trackAcousticBrainzState.durationMs = null;
      trackAcousticBrainzState.lastResult = null;
      try {
        const summary = await enrichTrackAcousticBrainz(abClient, getDriver(), request.log);
        trackAcousticBrainzState.lastResult = summary;
        trackAcousticBrainzState.completedAt = new Date().toISOString();
        trackAcousticBrainzState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        trackAcousticBrainzState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/track-acousticbrainz/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reset AcousticBrainz track enrichment markers for a full re-run',
        description:
          'Removes the `acousticBrainzFetched` marker and every audio-feature property ' +
          '(`tempo`, `musicalKey`, `musicalScale`, `loudnessDb`, `dynamicComplexity`, ' +
          '`danceabilityEstimate`, `voiceInstrumental`) from all Track nodes, causing the next ' +
          '`POST /api/v1/admin/track-acousticbrainz/enrich` call to re-process every track from ' +
          'scratch.\n\n' +
          'This endpoint is blocked while enrichment is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (trackAcousticBrainzState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'AcousticBrainz track enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      trackAcousticBrainzState.running = true;
      try {
        const reset = await resetTrackAcousticBrainzEnrichment(getDriver());
        return reply.send({ data: { reset } });
      } finally {
        trackAcousticBrainzState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | {
          data: {
            tracksProcessed: number;
            tracksSkipped: number;
            tracksFailed: number;
            durationMs: number;
          };
        }
      | { error: { code: string; message: string } };
  }>(
    '/track-deezer/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Track nodes with Deezer BPM and loudness',
        description:
          'For each Track that carries an `isrc` (set by `POST /api/v1/admin/track-musicbrainz/enrich`), ' +
          'looks the ISRC up against the free Deezer public API and writes `deezerBpm` and ' +
          '`deezerGain` (a loudness figure) onto the Track node. Blocks until complete.\n\n' +
          '**This step is NOT part of `POST /api/v1/admin/ingest` — it must be triggered manually, ' +
          'and only after track-musicbrainz enrichment has populated `isrc`.**\n\n' +
          'Deezer is an independent, ISRC-keyed source. `deezerBpm`/`deezerGain` are stored under ' +
          'distinct property names rather than overwriting the AcousticBrainz `tempo`/`loudnessDb` ' +
          'fields, so the source stays traceable and the two BPM figures can be compared. Deezer ' +
          'returns `0` for unknown values — those are stored as null.\n\n' +
          'All fields are nullable and best-effort. Uses `deezerFetched = true` as an idempotency ' +
          'marker; already-processed Track nodes are skipped. Run ' +
          '`POST /api/v1/admin/track-deezer/reset` first to re-process all tracks.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['tracksProcessed', 'tracksSkipped', 'tracksFailed', 'durationMs'],
                properties: {
                  tracksProcessed: { type: 'integer' },
                  tracksSkipped: { type: 'integer' },
                  tracksFailed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (trackDeezerState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Deezer track enrichment already in progress',
          },
        });
      }

      const deezerClient = buildDeezerClientFromEnv(request.log);

      trackDeezerState.running = true;
      trackDeezerState.startedAt = new Date().toISOString();
      trackDeezerState.completedAt = null;
      trackDeezerState.durationMs = null;
      trackDeezerState.lastResult = null;
      try {
        const summary = await enrichTrackDeezer(deezerClient, getDriver(), request.log);
        trackDeezerState.lastResult = summary;
        trackDeezerState.completedAt = new Date().toISOString();
        trackDeezerState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        trackDeezerState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/track-deezer/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reset Deezer track enrichment markers for a full re-run',
        description:
          'Removes the `deezerFetched` marker and the `deezerBpm` and `deezerGain` properties ' +
          'from all Track nodes, causing the next `POST /api/v1/admin/track-deezer/enrich` call ' +
          'to re-process every track from scratch.\n\n' +
          'This endpoint is blocked while enrichment is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (trackDeezerState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'Deezer track enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      trackDeezerState.running = true;
      try {
        const reset = await resetTrackDeezerEnrichment(getDriver());
        return reply.send({ data: { reset } });
      } finally {
        trackDeezerState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | { data: { enriched: number; skipped: number; failed: number; durationMs: number } }
      | { error: { code: string; message: string } };
  }>(
    '/artist-profiles/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Enrich Artist nodes with realName and profile from the Discogs artist API',
        description:
          'For each Artist node not yet enriched (`profileFetched IS NULL`), fetches ' +
          '`GET /artists/{id}` and writes `realName` and `profile`. Blocks until complete.\n\n' +
          '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
          'Use this endpoint to run it in isolation — e.g. after adding new artists from a re-ingest. ' +
          'Already-enriched artists are skipped via the `profileFetched` marker; run ' +
          '`POST /api/v1/admin/artist-profiles/reset` first to re-fetch every artist.\n\n' +
          'Requires `DISCOGS_TOKEN` env var.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['enriched', 'skipped', 'failed', 'durationMs'],
                properties: {
                  enriched: { type: 'integer' },
                  skipped: { type: 'integer' },
                  failed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
          503: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      const discogsClient = buildDiscogsClientFromEnv(request.log);
      if (!discogsClient) {
        return reply.code(503).send({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'DISCOGS_TOKEN not configured',
          },
        });
      }

      if (artistProfilesState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Artist profiles enrichment already in progress',
          },
        });
      }

      artistProfilesState.running = true;
      artistProfilesState.startedAt = new Date().toISOString();
      artistProfilesState.completedAt = null;
      artistProfilesState.durationMs = null;
      artistProfilesState.lastResult = null;
      try {
        const summary = await enrichArtistProfiles(discogsClient, getDriver(), request.log);
        artistProfilesState.lastResult = summary;
        artistProfilesState.completedAt = new Date().toISOString();
        artistProfilesState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        artistProfilesState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/artist-profiles/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reset artist profile enrichment markers for a full re-run',
        description:
          'Removes the `profileFetched` marker and the `realName` and `profile` properties from ' +
          'all Artist nodes, causing the next `POST /api/v1/admin/artist-profiles/enrich` call to ' +
          're-fetch every artist from scratch.\n\n' +
          'This endpoint is blocked while enrichment is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (artistProfilesState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'Artist profiles enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      artistProfilesState.running = true;
      try {
        const reset = await resetArtistProfilesEnrichment(getDriver());
        return reply.send({ data: { reset } });
      } finally {
        artistProfilesState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | {
          data: {
            genresEnriched: number;
            stylesEnriched: number;
            skipped: number;
            failed: number;
            durationMs: number;
          };
        }
      | { error: { code: string; message: string } };
  }>(
    '/artist-genres/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Aggregate genres and styles from releases onto Artist nodes',
        description:
          "Rolls each Artist's release genres/styles (via IN_GENRE and IN_STYLE) up onto the " +
          'Artist node as `genres[]` and `styles[]`. Pure graph computation — no external API. ' +
          'Blocks until complete.\n\n' +
          '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
          'Use this endpoint to recompute in isolation after a re-ingest adds releases.\n\n' +
          '**No reset endpoint:** the aggregation recomputes each Artist from scratch every run, ' +
          'so it is inherently idempotent and there is nothing to reset.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['genresEnriched', 'stylesEnriched', 'skipped', 'failed', 'durationMs'],
                properties: {
                  genresEnriched: { type: 'integer' },
                  stylesEnriched: { type: 'integer' },
                  skipped: { type: 'integer' },
                  failed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (artistGenresState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Artist genres enrichment already in progress',
          },
        });
      }
      artistGenresState.running = true;
      artistGenresState.startedAt = new Date().toISOString();
      artistGenresState.completedAt = null;
      artistGenresState.durationMs = null;
      artistGenresState.lastResult = null;
      try {
        const summary = await enrichArtistGenres(getDriver(), request.log);
        artistGenresState.lastResult = summary;
        artistGenresState.completedAt = new Date().toISOString();
        artistGenresState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        artistGenresState.running = false;
      }
    },
  );

  fastify.post<{
    Reply:
      | { data: { enriched: number; skipped: number; failed: number; durationMs: number } }
      | { error: { code: string; message: string } };
  }>(
    '/track-versions/enrich',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create IS_VERSION_OF relationships between Track variants',
        description:
          'Links Track variants that share a normalized title across releases by the same artist ' +
          'into IS_VERSION_OF relationships pointing at the earliest pressing. Pure graph ' +
          'computation — no external API. Blocks until complete.\n\n' +
          '**This step also runs automatically as part of `POST /api/v1/admin/ingest`.** ' +
          'Use this endpoint to recompute in isolation after a re-ingest. Relationships are ' +
          're-MERGEd, so re-running is safe and never creates duplicate edges; run ' +
          '`POST /api/v1/admin/track-versions/reset` first for a clean recompute.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['enriched', 'skipped', 'failed', 'durationMs'],
                properties: {
                  enriched: { type: 'integer' },
                  skipped: { type: 'integer' },
                  failed: { type: 'integer' },
                  durationMs: { type: 'integer' },
                },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (request, reply) => {
      if (trackVersionsState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Track versions enrichment already in progress',
          },
        });
      }
      trackVersionsState.running = true;
      trackVersionsState.startedAt = new Date().toISOString();
      trackVersionsState.completedAt = null;
      trackVersionsState.durationMs = null;
      trackVersionsState.lastResult = null;
      try {
        const summary = await enrichTrackVersions(getDriver(), request.log);
        trackVersionsState.lastResult = summary;
        trackVersionsState.completedAt = new Date().toISOString();
        trackVersionsState.durationMs = summary.durationMs;
        return reply.send({ data: summary });
      } finally {
        trackVersionsState.running = false;
      }
    },
  );

  fastify.post<{
    Reply: { data: { reset: number } } | { error: { code: string; message: string } };
  }>(
    '/track-versions/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete all IS_VERSION_OF relationships for a clean recompute',
        description:
          'Deletes every `IS_VERSION_OF` relationship in the graph, causing the next ' +
          '`POST /api/v1/admin/track-versions/enrich` call to rebuild the version graph from ' +
          'scratch. The relationships are purely derived, so this is non-destructive to source ' +
          'data.\n\n' +
          'This endpoint is blocked while enrichment is running.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['data'],
            properties: {
              data: {
                type: 'object',
                required: ['reset'],
                properties: { reset: { type: 'integer' } },
              },
            },
          },
          401: errorShape,
          409: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => {
      if (trackVersionsState.running) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message:
              'Track versions enrichment is currently running — wait for it to finish before resetting',
          },
        });
      }
      trackVersionsState.running = true;
      try {
        const reset = await resetTrackVersions(getDriver());
        return reply.send({ data: { reset } });
      } finally {
        trackVersionsState.running = false;
      }
    },
  );

  // ── Status endpoints ───────────────────────────────────────────────────────

  const enrichStatusSchema = (summary: Record<string, unknown>): Record<string, unknown> => ({
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['running', 'startedAt', 'completedAt', 'durationMs', 'lastResult'],
        properties: {
          running: { type: 'boolean' },
          startedAt: { type: 'string', nullable: true },
          completedAt: { type: 'string', nullable: true },
          durationMs: { type: 'number', nullable: true },
          lastResult: { ...summary, nullable: true },
        },
      },
    },
  });

  const standardSummarySchema = {
    type: 'object',
    properties: {
      enriched: { type: 'integer' },
      skipped: { type: 'integer' },
      failed: { type: 'integer' },
      durationMs: { type: 'integer' },
    },
  };

  fastify.get(
    '/lyrics/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent lyrics enrichment run',
        security: [{ bearerAuth: [] }],
        response: { 200: enrichStatusSchema(standardSummarySchema), 401: errorShape },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(lyricsState) }),
  );

  fastify.get(
    '/nationality/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent nationality enrichment run',
        security: [{ bearerAuth: [] }],
        response: { 200: enrichStatusSchema(standardSummarySchema), 401: errorShape },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(nationalityState) }),
  );

  fastify.get(
    '/master-data/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent master data enrichment run',
        security: [{ bearerAuth: [] }],
        response: { 200: enrichStatusSchema(standardSummarySchema), 401: errorShape },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(masterDataState) }),
  );

  fastify.get(
    '/mb-release-events/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent MusicBrainz release events enrichment run',
        security: [{ bearerAuth: [] }],
        response: {
          200: enrichStatusSchema({
            type: 'object',
            properties: {
              mastersProcessed: { type: 'integer' },
              mastersSkipped: { type: 'integer' },
              mastersFailed: { type: 'integer' },
              eventsWritten: { type: 'integer' },
              durationMs: { type: 'integer' },
            },
          }),
          401: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(mbReleaseEventsState) }),
  );

  fastify.get(
    '/track-musicbrainz/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent MusicBrainz track enrichment run',
        security: [{ bearerAuth: [] }],
        response: {
          200: enrichStatusSchema({
            type: 'object',
            properties: {
              releasesProcessed: { type: 'integer' },
              releasesSkipped: { type: 'integer' },
              releasesFailed: { type: 'integer' },
              tracksMatched: { type: 'integer' },
              tracksUnmatched: { type: 'integer' },
              durationMs: { type: 'integer' },
            },
          }),
          401: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(trackMusicBrainzState) }),
  );

  fastify.get(
    '/track-acousticbrainz/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent AcousticBrainz track enrichment run',
        security: [{ bearerAuth: [] }],
        response: {
          200: enrichStatusSchema({
            type: 'object',
            properties: {
              tracksProcessed: { type: 'integer' },
              tracksSkipped: { type: 'integer' },
              tracksFailed: { type: 'integer' },
              durationMs: { type: 'integer' },
            },
          }),
          401: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(trackAcousticBrainzState) }),
  );

  fastify.get(
    '/track-deezer/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent Deezer track enrichment run',
        security: [{ bearerAuth: [] }],
        response: {
          200: enrichStatusSchema({
            type: 'object',
            properties: {
              tracksProcessed: { type: 'integer' },
              tracksSkipped: { type: 'integer' },
              tracksFailed: { type: 'integer' },
              durationMs: { type: 'integer' },
            },
          }),
          401: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(trackDeezerState) }),
  );

  fastify.get(
    '/artist-profiles/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent artist profiles enrichment run',
        security: [{ bearerAuth: [] }],
        response: { 200: enrichStatusSchema(standardSummarySchema), 401: errorShape },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(artistProfilesState) }),
  );

  fastify.get(
    '/artist-genres/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent artist genres enrichment run',
        security: [{ bearerAuth: [] }],
        response: {
          200: enrichStatusSchema({
            type: 'object',
            properties: {
              genresEnriched: { type: 'integer' },
              stylesEnriched: { type: 'integer' },
              skipped: { type: 'integer' },
              failed: { type: 'integer' },
              durationMs: { type: 'integer' },
            },
          }),
          401: errorShape,
        },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(artistGenresState) }),
  );

  fastify.get(
    '/track-versions/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Status of the most recent track versions enrichment run',
        security: [{ bearerAuth: [] }],
        response: { 200: enrichStatusSchema(standardSummarySchema), 401: errorShape },
      },
      preHandler: adminAuthHook,
    },
    async (_request, reply) => reply.send({ data: structuredClone(trackVersionsState) }),
  );
}

export function resetAllPipelineStates(): void {
  Object.assign(lyricsState, makePipelineState<EnrichSummary>());
  Object.assign(nationalityState, makePipelineState<EnrichSummary>());
  Object.assign(masterDataState, makePipelineState<EnrichSummary>());
  Object.assign(mbReleaseEventsState, makePipelineState<MbReleaseEventsSummary>());
  Object.assign(trackMusicBrainzState, makePipelineState<TrackMusicBrainzSummary>());
  Object.assign(trackAcousticBrainzState, makePipelineState<TrackAcousticBrainzSummary>());
  Object.assign(trackDeezerState, makePipelineState<TrackDeezerSummary>());
  Object.assign(artistProfilesState, makePipelineState<EnrichSummary>());
  Object.assign(artistGenresState, makePipelineState<ArtistGenresSummary>());
  Object.assign(trackVersionsState, makePipelineState<EnrichSummary>());
}
