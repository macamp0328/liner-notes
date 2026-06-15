#!/usr/bin/env tsx
// Generate the committed Insomnia v5 collection from the committed OpenAPI
// spec. Run via `pnpm insomnia:generate`, which chains:
//
//   docs:generate (routes → docs/openapi.json, DB-free)
//     → this script (openapi.json → docs/insomnia.collection.yaml)
//       → prettier --write (final formatting authority, same as docs:generate)
//
// Determinism contract: the same openapi.json (with PROD_API_URL unset — the
// canonical committed artifact) produces byte-identical YAML. CI regenerates
// on PRs touching routes/docs/this script and fails on drift
// (.github/workflows/insomnia.yml), which also guards openapi.json itself.
//
// The emitted document is self-validated on every run (parse back + assert
// structural invariants in validate.ts), so the import-critical rules verified
// against Insomnia's import-v5-parser.ts are enforced in CI, not just documented.
//
// Re-import note: Insomnia regenerates ids on import, so re-importing
// DUPLICATES a collection rather than updating it — delete the old one,
// import fresh, re-paste admin_token (README documents this).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  DEFAULT_PROD_URL,
  collectOperations,
  openapiToInsomnia,
  type OpenApiSpec,
} from './openapi-to-insomnia.js';
import { validateDocument } from './validate.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC_FILE = join(REPO_ROOT, 'services', 'graph-service', 'docs', 'openapi.json');
const OUT_FILE = join(REPO_ROOT, 'services', 'graph-service', 'docs', 'insomnia.collection.yaml');

function main(): void {
  const prodUrl = process.env['PROD_API_URL']?.trim() || DEFAULT_PROD_URL;
  const spec = JSON.parse(readFileSync(SPEC_FILE, 'utf8')) as OpenApiSpec;

  const document = openapiToInsomnia(spec, { prodUrl });
  // aliasDuplicateObjects: false — never emit YAML anchors (*ref_0), which
  // the importer does not resolve the way a committed artifact needs.
  // lineWidth: 0 — never fold long URLs/descriptions across lines.
  const yamlText = stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 });

  const failures = validateDocument(yamlText, spec, prodUrl);
  if (failures.length > 0) {
    console.error('Insomnia collection failed self-validation:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  writeFileSync(OUT_FILE, yamlText);
  const ops = collectOperations(spec);
  console.log(
    `Insomnia collection written to services/graph-service/docs/insomnia.collection.yaml ` +
      `(${ops.length} requests, ${document.collection.length} top-level folders, prod=${prodUrl})`,
  );
}

main();
