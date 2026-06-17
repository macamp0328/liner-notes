import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeCountryClause,
  mergeRegionClause,
  mergeStudioClause,
} from '../../../src/db/canonical-merges.js';

// The write-path chokepoint guard (ADR 0005, law 6 + "The guard"). `Country` and `Studio` are
// multi-writer controlled-vocabulary nodes: their node MERGE must come from the single canonical
// helper in `src/db/canonical-merges.ts` so normalization/identity rules can't drift writer-to-
// writer (the proven GB/UK Country fragmentation). This test scans `src/db/**` and fails CI if a raw
// `MERGE (:Country …)` / `MERGE (:Studio …)` clause reappears anywhere but the helper module — the
// fail-loud wall that survives the next parallel session.
//
// SCOPE: this file now holds BOTH write-path guards from ADR 0005. The Country/Studio node-MERGE
// chokepoint (law 6) is immediately below; the law-7 edge-provenance guard (every provenance-bearing
// edge writer sets `source`, plus an inverted check that no edge type goes unclassified) is further
// down — it was added with the uniform-`source` sub-issue (#442) that tags the previously-untagged
// Discogs/MB edge writers. Both scan `src/db/**` because the architecture keeps all Cypher in the
// repository layer.

// Matches `Country`/`Region`/`Studio` used as a label inside a MERGE *node* pattern: `MERGE (` then
// any run of non-`)` chars (so anonymous `MERGE (:Country` and multi-label `MERGE (c:Foo:Country` are
// both caught) then `:Country`/`:Region`/`:Studio`. The `[^)]*` stops at the first `)`, so a rel MERGE
// like `MERGE (a)-[:ORIGIN_COUNTRY]->(c)` never matches (its `COUNTRY` lives in the `[…]` after the
// closing paren). Known blind spot: lowercase `merge` — the repo writes Cypher keywords uppercase by
// convention, so it is not worth the false-positive risk of matching the English word "merge".
const RAW_ENTITY_MERGE = /MERGE\s*\(\s*[^)]*:\s*(Country|Region|Studio)\b/g;

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

// ── Law 7 (ADR 0005): uniform edge provenance ──────────────────────────────────────────────────
// Every *provenance-bearing* edge writer must set a `source` property on the edge it MERGEs, so an
// "untagged" edge stops being a possible state. A type is provenance-bearing when it can be written
// by more than one source (the relationship type name alone then can't disambiguate provenance):
// CREDITED_ON (Discogs|MB), RECORDED_AT (Discogs release|MB track), MEMBER_OF (Discogs|Wikidata),
// ORIGIN_COUNTRY (MB|Wikidata), plus the MB/Wikidata-only INFLUENCED_BY/WROTE/RECORDING_OF/
// MB_RELEASED_IN tagged for uniformity. Structural / single-source edges deliberately carry no
// `source` — note RELEASED_IN is the Discogs Master→Country edge whose MusicBrainz counterpart is the
// *distinct* type MB_RELEASED_IN, so its provenance already lives in the type name. Half A flags a
// provenance edge missing `source`; Half B flags any edge type in NEITHER set, so a NEW edge type
// can't slip past unclassified — the wall that survives the next parallel session.
const PROVENANCE_BEARING_EDGES = new Set<string>([
  'CREDITED_ON',
  'RECORDED_AT',
  'MEMBER_OF',
  'ORIGIN_COUNTRY',
  'INFLUENCED_BY',
  'WROTE',
  'RECORDING_OF',
  'MB_RELEASED_IN',
  // #441: the Region counterpart of MB_RELEASED_IN — same MusicBrainz provenance, distinct endpoint.
  'MB_RELEASED_IN_REGION',
]);

const STRUCTURAL_EDGES = new Set<string>([
  'RELEASED_BY',
  'ON_LABEL',
  'IN_GENRE',
  'IN_STYLE',
  'FROM_COUNTRY',
  'HAS_TRACK',
  'RELEASED_IN',
  'PARENT_LABEL',
  'SAME_PERSON_AS',
  'HAS_STAGE',
  // #441: Region counterparts of the structural place edges (Discogs-sourced; provenance is in the
  // type name, same as their Country variants).
  'FROM_REGION',
  'RELEASED_IN_REGION',
]);

// Matches an edge created by MERGE/CREATE, capturing (1) the relationship variable (empty for an
// anonymous edge), (2) the relationship type, (3) the inline property block before `]`. Anchored on
// MERGE/CREATE so reads (`MATCH (a)-[:CREDITED_ON]->()`, `WHERE r.source = …`) never match; the `<?`
// tolerates a future reverse-directed edge; a `${mergeCountryClause(...)}` interpolation is plain
// text with no trailing `-[`, so the node-MERGE helpers are ignored.
const EDGE_MERGE =
  /(?:MERGE|CREATE)\s*\([^)]*\)\s*<?-\s*\[\s*(\w*)\s*:\s*([A-Z][A-Z_]*)\b([^\]]*)\]/g;

interface EdgeMergeRef {
  relVar: string;
  relType: string;
  inlineProps: string;
  match: string;
  /** Index just past the matched `]`, where this edge's SET tail begins. */
  end: number;
}

interface EdgeViolation {
  relType: string;
  match: string;
}

/** Every edge-creating MERGE/CREATE in a single Cypher string (pure — the unit under test). */
function scanEdgeMerges(cypher: string): EdgeMergeRef[] {
  return [...cypher.matchAll(EDGE_MERGE)].map((m) => ({
    relVar: m[1] as string,
    relType: m[2] as string,
    inlineProps: m[3] as string,
    match: m[0],
    end: (m.index ?? 0) + m[0].length,
  }));
}

/**
 * `source` is set on THIS edge when it is an inline property (merge key or pattern prop) OR a named
 * relVar's `<relVar>.source` appears in the tail from this match up to the next MERGE/RETURN (its
 * SET / ON CREATE SET). Bounding the tail is what makes the check "set on this edge" rather than "the
 * string appears somewhere in the query" — a `WHERE relVar.source` read elsewhere can't fake a tag.
 * Assumes a writer tags `source` in the SET immediately following its edge MERGE, before any later
 * MERGE/RETURN (true of every writer today); one that deferred it past another clause would
 * false-FAIL loudly — the safe direction for a CI guard, never a silent false pass.
 */
function edgeHasSource(cypher: string, edge: EdgeMergeRef): boolean {
  if (/\bsource\b/.test(edge.inlineProps)) return true;
  if (edge.relVar === '') return false;
  // split always yields ≥1 element, but noUncheckedIndexedAccess types [0] as possibly-undefined.
  const tail = cypher.slice(edge.end).split(/\bMERGE\b|\bRETURN\b/)[0] ?? '';
  return tail.includes(`${edge.relVar}.source`);
}

/** Provenance-bearing edge MERGEs in one Cypher string that omit `source` (law 7, Half A). */
export function scanForUntaggedProvenanceEdges(cypher: string): EdgeViolation[] {
  return scanEdgeMerges(cypher)
    .filter((e) => PROVENANCE_BEARING_EDGES.has(e.relType) && !edgeHasSource(cypher, e))
    .map((e) => ({ relType: e.relType, match: e.match }));
}

/** Edge MERGEs whose type is classified neither provenance-bearing nor structural (Half B). */
export function scanForUnclassifiedEdges(cypher: string): EdgeViolation[] {
  return scanEdgeMerges(cypher)
    .filter((e) => !PROVENANCE_BEARING_EDGES.has(e.relType) && !STRUCTURAL_EDGES.has(e.relType))
    .map((e) => ({ relType: e.relType, match: e.match }));
}

/** Backtick-delimited Cypher template bodies (pure). Assumes templates nest no backticks (true here). */
export function extractCypherTemplates(fileSource: string): string[] {
  return [...fileSource.matchAll(/`([^`]*)`/g)].map((m) => m[1] as string);
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

  it('flags a raw Region node MERGE and the canonical Region helper output (#441)', () => {
    expect(scanForRawEntityMerges('MERGE (g:Region {name: $x})')).toEqual([
      { entity: 'Region', match: 'MERGE (g:Region' },
    ]);
    // The helper output IS a raw clause — legal only because it lives in canonical-merges.ts.
    expect(scanForRawEntityMerges(mergeRegionClause('row.code'))).toEqual([
      { entity: 'Region', match: 'MERGE (g:Region' },
    ]);
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

describe('extractCypherTemplates', () => {
  it('returns each backtick-delimited template body', () => {
    expect(extractCypherTemplates('const a = `MERGE (x)`; const b = `RETURN 1`;')).toEqual([
      'MERGE (x)',
      'RETURN 1',
    ]);
  });
});

describe('scanForUntaggedProvenanceEdges', () => {
  it('flags a provenance edge whose writer sets no source', () => {
    expect(
      scanForUntaggedProvenanceEdges('MERGE (m)-[co:CREDITED_ON]->(r) SET co.role = $role'),
    ).toEqual([{ relType: 'CREDITED_ON', match: 'MERGE (m)-[co:CREDITED_ON]' }]);
  });

  it('flags an anonymous (unnamed) provenance edge', () => {
    expect(
      scanForUntaggedProvenanceEdges('MATCH (r:Release) MERGE (r)-[:RECORDED_AT]->(s)'),
    ).toEqual([{ relType: 'RECORDED_AT', match: 'MERGE (r)-[:RECORDED_AT]' }]);
  });

  it('accepts source as an inline merge-key property', () => {
    expect(
      scanForUntaggedProvenanceEdges("MERGE (a)-[rel:MEMBER_OF {source: 'wikidata'}]->(b)"),
    ).toEqual([]);
  });

  it('accepts source set via SET and via ON CREATE SET', () => {
    expect(
      scanForUntaggedProvenanceEdges(
        'MERGE (m)-[co:CREDITED_ON]->(r) SET co.role = $r, co.source = "discogs"',
      ),
    ).toEqual([]);
    expect(
      scanForUntaggedProvenanceEdges(
        "MERGE (t)-[ra:RECORDED_AT]->(s) ON CREATE SET ra.source = 'musicbrainz'",
      ),
    ).toEqual([]);
  });

  it('does not count an inline non-source merge key as a tag', () => {
    expect(
      scanForUntaggedProvenanceEdges(
        'MERGE (m)-[r:MB_RELEASED_IN {mbReleaseId: $x}]->(c) SET r.date = $d',
      ),
    ).toEqual([
      { relType: 'MB_RELEASED_IN', match: 'MERGE (m)-[r:MB_RELEASED_IN {mbReleaseId: $x}]' },
    ]);
  });

  it('does not let a WHERE source read elsewhere tag an untagged edge', () => {
    // The tail is bounded to before the next MERGE, so the leading read of `co.source` can't fake it.
    expect(
      scanForUntaggedProvenanceEdges(
        'MATCH (x)-[co:CREDITED_ON]->(y) WHERE co.source = "x" WITH x ' +
          'MERGE (m)-[co:CREDITED_ON]->(r) SET co.role = $role',
      ),
    ).toHaveLength(1);
  });

  it('scans only the edge MERGE, not a leading node MERGE, in a multi-MERGE query', () => {
    const cypher = `${mergeStudioClause('$name')}\nWITH s\nMATCH (r:Release)\nMERGE (r)-[:RECORDED_AT]->(s)`;
    expect(scanForUntaggedProvenanceEdges(cypher)).toEqual([
      { relType: 'RECORDED_AT', match: 'MERGE (r)-[:RECORDED_AT]' },
    ]);
  });

  it('ignores structural edges and pure reads', () => {
    expect(
      scanForUntaggedProvenanceEdges('MERGE (r)-[ht:HAS_TRACK]->(t) SET ht.trackNumber = $n'),
    ).toEqual([]);
    expect(scanForUntaggedProvenanceEdges('MATCH (m)-[:CREDITED_ON]->(r) RETURN r')).toEqual([]);
  });
});

describe('scanForUnclassifiedEdges', () => {
  it('flags an edge type in neither classification set', () => {
    expect(scanForUnclassifiedEdges('MERGE (a)-[r:BANANA_OF]->(b)')).toEqual([
      { relType: 'BANANA_OF', match: 'MERGE (a)-[r:BANANA_OF]' },
    ]);
  });

  it('passes a known structural and a known provenance type', () => {
    expect(scanForUnclassifiedEdges('MERGE (r)-[ht:HAS_TRACK]->(t)')).toEqual([]);
    expect(scanForUnclassifiedEdges('MERGE (m)-[co:CREDITED_ON]->(r)')).toEqual([]);
  });
});

describe('edge provenance guard over src/db', () => {
  function scanDir(scan: (cypher: string) => EdgeViolation[], hint: string): string[] {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DB_ROOT)) {
      // file is one of this repo's own src/db sources (see collectSourceFiles) — trusted path.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(file, 'utf8');
      for (const cypher of extractCypherTemplates(source)) {
        for (const v of scan(cypher)) {
          offenders.push(`${relative(SRC_DB_ROOT, file)}: ${v.match}… — ${hint}`);
        }
      }
    }
    return offenders;
  }

  it('sets source on every provenance-bearing edge writer (law 7)', () => {
    expect(scanDir(scanForUntaggedProvenanceEdges, 'provenance edge omits source')).toEqual([]);
  });

  it('classifies every edge type as provenance-bearing or structural', () => {
    expect(
      scanDir(
        scanForUnclassifiedEdges,
        'unclassified edge type — add to PROVENANCE_BEARING_EDGES or STRUCTURAL_EDGES',
      ),
    ).toEqual([]);
  });
});
