import { buildServer } from './server.js';

const start = async (): Promise<void> => {
  const app = await buildServer();
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });

  // Graceful shutdown — triggers onClose hook which closes the Neo4j driver
  const shutdown = (): void => {
    void app.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
