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

// eslint-disable-next-line @typescript-eslint/require-await
export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Body: { force?: boolean };
    Reply:
      | { data: { jobId: string; message: string } }
      | { error: { code: string; message: string; jobId?: string } };
  }>(
    '/ingest',
    {
      schema: {
        tags: ['admin'],
        summary: 'Trigger full Discogs → Neo4j ingestion pipeline',
        security: [{ bearerAuth: [] }],
        body: {
          anyOf: [
            {
              type: 'object',
              properties: {
                force: { type: 'boolean', description: 'Re-run even if graph is not empty' },
              },
            },
            { type: 'null' },
          ],
        },
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
}
