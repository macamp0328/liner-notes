import Fastify from 'fastify';

const server = Fastify({ logger: true });

server.get('/api/v1/health', async () => {
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
