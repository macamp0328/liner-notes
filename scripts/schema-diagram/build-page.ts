#!/usr/bin/env tsx
// Assemble the GitHub Pages site from the COMMITTED artifacts — DB-free, so the
// Pages workflow needs no AWS/secrets. Run via `pnpm schema:page`. Writes
// `_site/index.html` (uploaded as the Pages artifact, never committed).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPageHtml } from './render.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCHEMA_DIR = join(ROOT, 'services', 'graph-service', 'docs', 'schema');
const SITE_DIR = join(ROOT, '_site');

const er = readFileSync(join(SCHEMA_DIR, 'schema-er.mmd'), 'utf8').trimEnd();
const graph = readFileSync(join(SCHEMA_DIR, 'schema-graph.mmd'), 'utf8').trimEnd();
const template = readFileSync(join(import.meta.dirname, 'page-template.html'), 'utf8');

// Pull the drift status out of the committed SCHEMA.md ("**Drift:** …").
const schemaMd = readFileSync(join(SCHEMA_DIR, 'SCHEMA.md'), 'utf8');
const driftMatch = /\*\*Drift:\*\* (.+)/.exec(schemaMd);
const driftStatus = driftMatch?.[1] ?? 'unknown';

// The page is NOT committed, so a timestamp here is fine (no determinism gate).
// The workflow passes the deploy commit/date in; fall back for local runs.
const lastUpdated = process.env['SCHEMA_PAGE_DATE'] ?? 'unknown';

mkdirSync(SITE_DIR, { recursive: true });
writeFileSync(
  join(SITE_DIR, 'index.html'),
  buildPageHtml(template, er, graph, { lastUpdated, driftStatus }),
);
console.log(`schema page → _site/index.html (updated ${lastUpdated})`);
