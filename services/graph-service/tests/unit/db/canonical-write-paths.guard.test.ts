import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCountryClause, mergeStudioClause } from '../../../src/db/canonical-merges.js';

// The write-path chokepoint guard (ADR 0005, law 6 + "The guard"). `Country` and `Studio` are
// multi-writer controlled-vocabulary nodes: their node MERGE must come from the single canonical
// helper in `src/db/canonical-merges.ts` so normalization/identity rules can't drift writer-to-
// writer (the proven GB/UK Country fragmentation). This test scans `src/db/**` and fails CI if a raw
// `MERGE (:Country …)` / `MERGE (:Studio …)` clause reappears anywhere but the helper module — the
// fail-loud wall that survives the next parallel session.
//
// SCOPE: this guard covers the Country/Studio node-MERGE chokepoint only. The sibling "every edge
// writer sets `source`" provenance guard (ADR 0005, law 7) ships with the uniform-`source` sub-issue
// that actually tags the currently-untagged Discogs writers — adding it here would red-flag existing
// writers this refactor deliberately leaves byte-identical.

// Matches `Country`/`Studio` used as a label inside a MERGE *node* pattern: `MERGE (` then any run
// of non-`)` chars (so anonymous `MERGE (:Country` and multi-label `MERGE (c:Foo:Country` are both
// caught) then `:Country`/`:Studio`. The `[^)]*` stops at the first `)`, so a relationship MERGE
// like `MERGE (a)-[:ORIGIN_COUNTRY]->(c)` never matches (its `COUNTRY` lives in the `[…]` after the
// closing paren). Known blind spot: lowercase `merge` — the repo writes Cypher keywords uppercase by
// convention, so it is not worth the false-positive risk of matching the English word "merge".
const RAW_ENTITY_MERGE = /MERGE\s*\(\s*[^)]*:\s*(Country|Studio)\b/g;

// The one file allowed to contain a raw Country/Studio node MERGE — it IS the canonical clause.
// Matched on the SRC_DB_ROOT-relative path (not basename) so a future same-named file in a
// subdirectory can't silently exempt itself from the guard.
const LEGAL_RAW_MERGE_FILES = ['canonical-merges.ts'];

const THIS_FILE = fileURLToPath(import.meta.url);
const SRC_DB_ROOT = join(dirname(THIS_FILE), '..', '..', '..', 'src', 'db');

interface RawMergeViolation {
  entity: string;
  match: string;
}

/** Find every raw Country/Studio node MERGE in a source string (pure — the unit under test). */
export function scanForRawEntityMerges(source: string): RawMergeViolation[] {
  // Group 1 is a mandatory alternation, so it is always present on a successful match.
  return [...source.matchAll(RAW_ENTITY_MERGE)].map((m) => ({
    entity: m[1] as string,
    match: m[0],
  }));
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  // dir descends from SRC_DB_ROOT (derived from import.meta.url) over this repo's own source tree —
  // no untrusted input reaches the path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('scanForRawEntityMerges', () => {
  it('flags a raw Country node MERGE', () => {
    expect(scanForRawEntityMerges('MERGE (c:Country {name: $x})')).toEqual([
      { entity: 'Country', match: 'MERGE (c:Country' },
    ]);
  });

  it('flags an anonymous and a multi-label node MERGE', () => {
    expect(scanForRawEntityMerges('MERGE (:Country {name: $x})')).toHaveLength(1);
    expect(scanForRawEntityMerges('MERGE (c:Cached:Studio {name: $x})')).toEqual([
      { entity: 'Studio', match: 'MERGE (c:Cached:Studio' },
    ]);
  });

  it('does NOT flag a MATCH, the canonical helper output, or a relationship MERGE', () => {
    expect(scanForRawEntityMerges('MATCH (c:Country {name: $x})')).toEqual([]);
    expect(scanForRawEntityMerges(mergeCountryClause('$x'))).toEqual([
      // The helper output IS a raw clause — it is legal only because it lives in canonical-merges.ts,
      // which the directory scan excludes. The scanner itself still flags the string (correct).
      { entity: 'Country', match: 'MERGE (c:Country' },
    ]);
    expect(scanForRawEntityMerges('MERGE (a)-[rel:ORIGIN_COUNTRY]->(c)')).toEqual([]);
    expect(scanForRawEntityMerges(mergeStudioClause('p.name'))).toHaveLength(1);
  });
});

describe('canonical write-path guard over src/db', () => {
  it('routes every Country/Studio node MERGE through the canonical helper', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DB_ROOT)) {
      if (LEGAL_RAW_MERGE_FILES.includes(relative(SRC_DB_ROOT, file))) continue;
      // file is one of this repo's own src/db sources (see collectSourceFiles) — trusted path.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const violations = scanForRawEntityMerges(readFileSync(file, 'utf8'));
      for (const v of violations) {
        offenders.push(
          `${relative(SRC_DB_ROOT, file)}: ${v.match}… — use merge${v.entity}Clause()`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
