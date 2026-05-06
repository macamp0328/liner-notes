import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';

interface HealthResponse {
  status: 'ok' | 'error';
  neo4j: 'connected' | 'disconnected';
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Reply: HealthResponse }>(
    '/api/v1/health',
    {
      schema: {
        tags: ['ops'],
        summary: 'Service and Neo4j health check',
        response: {
          200: {
            type: 'object',
            required: ['status', 'neo4j'],
            properties: {
              status: { type: 'string', const: 'ok' },
              neo4j: { type: 'string', const: 'connected' },
            },
          },
          503: {
            type: 'object',
            required: ['status', 'neo4j'],
            properties: {
              status: { type: 'string', const: 'error' },
              neo4j: { type: 'string', const: 'disconnected' },
            },
          },
        },
      },
    },
    async (_request, reply): Promise<HealthResponse> => {
      try {
        await getDriver().verifyConnectivity();
        return { status: 'ok', neo4j: 'connected' };
      } catch {
        void reply.code(503);
        return { status: 'error', neo4j: 'disconnected' };
      }
    },
  );
}
