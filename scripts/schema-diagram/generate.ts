#!/usr/bin/env tsx
// Generate the committed data-model artifacts by introspecting a live Neo4j graph
// (prod Aura by default; any NEO4J_URI works, e.g. local docker-compose). Run via
// `pnpm schema:diagram`, which chains:
//
//   this script (live introspection → docs/schema/{snapshot.json,*.mmd,SCHEMA.md})
//     → prettier --write (final formatting authority for .json + .md; NOT .mmd)
//
// Unlike the code-derived generators (diagrams/insomnia), the source here is a
// live database, so this is non-deterministic w.r.t. the data and needs DB creds.
// It is therefore NOT a fail-on-drift CI gate — it's a scheduled producer that
// opens a PR (ADR 0004). Determinism w.r.t. the *model* still holds: a re-run on
// unchanged data produces byte-identical artifacts (everything is sorted; no
// counts/timestamps/ids), so the refresh no-ops instead of churning.
//
// When the DB is unreachable (Aura paused / node off) the run is a clean no-op:
// it logs and exits 0 without writing anything.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbUnreachableError, driverFromEnv, introspect } from './introspect.js';
import { buildSnapshot, serializeSnapshot } from './snapshot.js';
import { buildSchemaMarkdown, renderErDiagram, renderGraphDiagram } from './render.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const OUT_DIR = join(REPO_ROOT, 'services', 'graph-service', 'docs', 'schema');

// Prettier is the final formatting authority for the .json/.md artifacts so they
// pass the repo-wide `prettier --check .` (the .mmd have no parser → auto-skipped).
// Run from the generator (not the npm-script chain) so the asleep no-op writes
// nothing AND formats nothing. Absolute bin path keeps it working in worktrees.
function formatArtifacts(paths: string[]): void {
  const bin = join(REPO_ROOT, 'node_modules', '.bin', 'prettier');
  const r = spawnSync(bin, ['--write', ...paths], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`prettier --write failed (exit ${r.status ?? 'null'})`);
  }
}

async function main(): Promise<void> {
  const driver = driverFromEnv();
  let raw;
  try {
    raw = await introspect(driver);
  } catch (err) {
    if (err instanceof DbUnreachableError) {
      console.warn(`schema-diagram: ${err.message} — skipping, no artifacts written.`);
      return; // clean no-op (exit 0)
    }
    throw err; // ApocUnavailableError or any real error → loud failure
  } finally {
    await driver.close();
  }

  const snapshot = buildSnapshot(raw);
  const erBody = renderErDiagram(snapshot);
  const graphBody = renderGraphDiagram(snapshot);

  mkdirSync(OUT_DIR, { recursive: true });
  const snapshotPath = join(OUT_DIR, 'schema-snapshot.json');
  const schemaMdPath = join(OUT_DIR, 'SCHEMA.md');
  writeFileSync(snapshotPath, serializeSnapshot(snapshot));
  writeFileSync(join(OUT_DIR, 'schema-er.mmd'), `${erBody}\n`);
  writeFileSync(join(OUT_DIR, 'schema-graph.mmd'), `${graphBody}\n`);
  writeFileSync(schemaMdPath, buildSchemaMarkdown(erBody, graphBody));
  formatArtifacts([snapshotPath, schemaMdPath]);

  console.log(
    `schema-diagram: ${snapshot.labels.length} labels, ` +
      `${snapshot.relationships.length} relationships, ` +
      `${snapshot.constraints.length} constraints, ${snapshot.indexes.length} indexes ` +
      `→ services/graph-service/docs/schema/`,
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
