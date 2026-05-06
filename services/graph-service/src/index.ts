import { type FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

const start = async (): Promise<void> => {
  let app: FastifyInstance | undefined;
  try {
    app = await buildServer();
    const port = parseInt(process.env['PORT'] ?? '3000', 10);

    // Graceful shutdown — triggers onClose hook which closes the Neo4j driver
    const shutdown = (): void => {
      void app!
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error(err);
    // Attempt cleanup so the Neo4j driver and any other resources are closed
    // even when startup fails part-way through (e.g. Neo4j unreachable on boot)
    await app?.close().catch(() => undefined);
    process.exit(1);
  }
};

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
