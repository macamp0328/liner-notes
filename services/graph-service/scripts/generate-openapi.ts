/**
 * Generate the OpenAPI spec from the live route definitions and write it to
 * docs/openapi.json. Run with:
 *
 *   pnpm --filter graph-service docs:generate
 *
 * No database connection is required — uses buildDocsServer() which registers
 * routes and swagger without the Neo4j onReady hook.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildDocsServer } from '../src/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '../docs');
const outFile = join(outDir, 'openapi.json');

const app = await buildDocsServer();
await app.ready();

const spec = app.swagger();

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(spec, null, 2) + '\n');

await app.close();

console.log(`OpenAPI spec written to services/graph-service/docs/openapi.json`);
