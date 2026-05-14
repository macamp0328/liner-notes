import type { FastifyInstance } from 'fastify';
import { adminAuthHook } from './middleware/admin-auth.js';
import { getDriver } from '../db/client.js';
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
import { enrichArtistNationality } from '../enrichment/artist-nationality.js';
import { resetNationalityEnrichment } from '../db/artist-nationality-repository.js';
import { enrichMasterData } from '../enrichment/master-data.js';

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

let isEnriching = false;
let isEnrichingNationality = false;
let isEnrichingMasterData = false;

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
          '- `POST /api/v1/admin/nationality/enrich` — nationality data from MusicBrainz + Wikidata',
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
      if (isEnriching) {
        return reply.code(409).send({
          error: { code: 'ENRICHMENT_RUNNING', message: 'Lyrics enrichment already in progress' },
        });
      }
      isEnriching = true;
      try {
        const summary = await enrichLyrics(getDriver(), request.log);
        return reply.send({ data: summary });
      } finally {
        isEnriching = false;
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
          '**Sources (queried in parallel per node):**\n' +
          '- MusicBrainz: two-step lookup via Discogs URL → MBID → artist record. ' +
          'Falls back to `area.iso-3166-1-codes` when the `country` field is null.\n' +
          '- Wikidata: SPARQL lookup via Discogs artist ID property (P1953 → P27 → P297).\n\n' +
          '**Conflict resolution:** when sources disagree, Wikidata is preferred and the discrepancy is logged.\n\n' +
          'For musicians without a Discogs ID, MusicBrainz name search is used as a last resort (score ≥ 90 only).\n\n' +
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
      if (isEnrichingNationality) {
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

      isEnrichingNationality = true;
      try {
        const summary = await enrichArtistNationality(
          mbClient,
          getDriver(),
          request.log,
          wdClient ?? undefined,
        );
        return reply.send({ data: summary });
      } finally {
        isEnrichingNationality = false;
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
      if (isEnrichingNationality) {
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

      if (isEnrichingMasterData) {
        return reply.code(409).send({
          error: {
            code: 'ENRICHMENT_RUNNING',
            message: 'Master data enrichment already in progress',
          },
        });
      }

      isEnrichingMasterData = true;
      try {
        const summary = await enrichMasterData(discogsClient, getDriver(), request.log);
        return reply.send({ data: summary });
      } finally {
        isEnrichingMasterData = false;
      }
    },
  );
}
