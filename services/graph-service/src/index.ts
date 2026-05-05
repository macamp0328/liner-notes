import 'dotenv-flow/config';
import Fastify from 'fastify';

const server = Fastify({ logger: true });

server.get('/api/v1/health', () => {
  return { status: 'ok' };
});

const start = async (): Promise<void> => {
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await server.listen({ port, host: '0.0.0.0' });
};

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

const shutdown = (): void => {
  void server.close().then(() => process.exit(0)).catch(() => process.exit(1));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
