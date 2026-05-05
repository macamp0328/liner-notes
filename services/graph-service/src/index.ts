import { buildServer } from './server.js';

const start = async (): Promise<void> => {
  const app = await buildServer();
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
};

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
