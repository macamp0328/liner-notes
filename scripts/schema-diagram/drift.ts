// Pure drift detection — two exact, machine-readable comparisons (ADR 0004 §4):
//
//   1. Model drift  — current introspection vs the LAST COMMITTED snapshot.
//                     The "what changed in the graph since we last accepted it" signal.
//   2. Code↔DB drift — prod constraints/indexes vs the names DECLARED in
//                     src/db/schema.ts (read as text). Advisory/secondary: it
//                     ignores constraint-backed indexes (owningConstraint != null)
//                     and LOOKUP token indexes, which are noise.
//
// No I/O, no driver — unit-tested with canned input.

import { type SchemaSnapshot, byString } from './snapshot.js';

export interface ModelDrift {
  addedLabels: string[];
  removedLabels: string[];
  addedProperties: Array<{ label: string; property: string; types: string[] }>;
  removedProperties: Array<{ label: string; property: string }>;
  changedProperties: Array<{ label: string; property: string; from: string[]; to: string[] }>;
  addedRelationships: Array<{ type: string; from: string; to: string }>;
  removedRelationships: Array<{ type: string; from: string; to: string }>;
}

export interface CodeDbDrift {
  inDbNotInCode: { constraints: string[]; indexes: string[] };
  inCodeNotInDb: { constraints: string[]; indexes: string[] };
}

export interface DriftReport {
  model: ModelDrift;
  codeDb: CodeDbDrift;
  hasModelDrift: boolean;
  hasCodeDbDrift: boolean;
}

function relKey(r: { type: string; from: string; to: string }): string {
  return `${r.type} ${r.from} ${r.to}`;
}

/** Compare the freshly-introspected snapshot to the last committed one. A null
 *  previous (no snapshot committed yet) is a baseline → no drift. */
export function diffModel(previous: SchemaSnapshot | null, current: SchemaSnapshot): ModelDrift {
  const empty: ModelDrift = {
    addedLabels: [],
    removedLabels: [],
    addedProperties: [],
    removedProperties: [],
    changedProperties: [],
    addedRelationships: [],
    removedRelationships: [],
  };
  if (previous === null) return empty;

  const prevLabels = new Map(previous.labels.map((l) => [l.label, l]));
  const currLabels = new Map(current.labels.map((l) => [l.label, l]));

  const addedLabels = [...currLabels.keys()].filter((l) => !prevLabels.has(l)).sort(byString);
  const removedLabels = [...prevLabels.keys()].filter((l) => !currLabels.has(l)).sort(byString);

  const addedProperties: ModelDrift['addedProperties'] = [];
  const removedProperties: ModelDrift['removedProperties'] = [];
  const changedProperties: ModelDrift['changedProperties'] = [];
  // Only diff properties for labels present in BOTH — a whole added/removed label
  // is already reported above, listing each of its props would be noise.
  for (const [label, curr] of currLabels) {
    const prev = prevLabels.get(label);
    if (prev === undefined) continue;
    const prevProps = new Map(prev.properties.map((p) => [p.name, p]));
    const currProps = new Map(curr.properties.map((p) => [p.name, p]));
    for (const [name, p] of currProps) {
      const prevP = prevProps.get(name);
      if (prevP === undefined) {
        addedProperties.push({ label, property: name, types: p.types });
      } else if (prevP.types.join('|') !== p.types.join('|')) {
        // A property whose type set changed (e.g. Long → String) — a real model
        // regression that a name-only diff would silently miss. `types` is sorted
        // in the snapshot, so the join comparison is order-stable.
        changedProperties.push({ label, property: name, from: prevP.types, to: p.types });
      }
    }
    for (const name of prevProps.keys()) {
      if (!currProps.has(name)) removedProperties.push({ label, property: name });
    }
  }
  const byLabelProp = (
    a: { label: string; property: string },
    b: { label: string; property: string },
  ): number => byString(a.label, b.label) || byString(a.property, b.property);
  addedProperties.sort(byLabelProp);
  removedProperties.sort(byLabelProp);
  changedProperties.sort(byLabelProp);

  const prevRels = new Set(previous.relationships.map(relKey));
  const currRels = new Set(current.relationships.map(relKey));
  const addedRelationships = current.relationships
    .filter((r) => !prevRels.has(relKey(r)))
    .sort((a, b) => byString(relKey(a), relKey(b)));
  const removedRelationships = previous.relationships
    .filter((r) => !currRels.has(relKey(r)))
    .sort((a, b) => byString(relKey(a), relKey(b)));

  return {
    addedLabels,
    removedLabels,
    addedProperties,
    removedProperties,
    changedProperties,
    addedRelationships,
    removedRelationships,
  };
}

/** Extract the names CREATEd in src/db/schema.ts (as text), classified into
 *  constraints vs indexes. Ignores DROP/MATCH lines (no CREATE) — keeps the
 *  script self-contained (it never imports service code). */
export function extractDeclaredSchemaNames(schemaTsSource: string): {
  constraints: string[];
  indexes: string[];
} {
  // Literal single spaces (schema.ts is consistently single-spaced) — avoids a
  // nested quantifier (\s+ under ?), which trips detect-unsafe-regex. The optional
  // group enumerates every Neo4j index modifier (literals, no quantifier) so a
  // TEXT/POINT/VECTOR/RANGE/LOOKUP index isn't misread as un-declared → false drift.
  const re =
    /CREATE (?:(?:FULLTEXT|TEXT|POINT|VECTOR|RANGE|LOOKUP) )?(CONSTRAINT|INDEX) (\w+) IF NOT EXISTS/g;
  const constraints = new Set<string>();
  const indexes = new Set<string>();
  for (const m of schemaTsSource.matchAll(re)) {
    const kind = m[1];
    const name = m[2];
    if (name === undefined) continue;
    if (kind === 'CONSTRAINT') constraints.add(name);
    else indexes.add(name);
  }
  return {
    constraints: [...constraints].sort(byString),
    indexes: [...indexes].sort(byString),
  };
}

export function diffCodeDb(
  declared: { constraints: string[]; indexes: string[] },
  current: SchemaSnapshot,
): CodeDbDrift {
  const declaredConstraints = new Set(declared.constraints);
  const declaredIndexes = new Set(declared.indexes);

  const prodConstraints = current.constraints.map((c) => c.name);
  // De-noise: a uniqueness constraint's auto-created backing index shares its
  // name (owningConstraint != null) and schema.ts declares it as a CONSTRAINT,
  // not an INDEX; LOOKUP token indexes are implicit. Neither is real drift.
  const prodIndexes = current.indexes
    .filter((i) => i.owningConstraint === null && i.indexType !== 'LOOKUP')
    .map((i) => i.name);

  const minus = (a: string[], b: Set<string>): string[] =>
    [...new Set(a.filter((x) => !b.has(x)))].sort(byString);

  return {
    inDbNotInCode: {
      constraints: minus(prodConstraints, declaredConstraints),
      indexes: minus(prodIndexes, declaredIndexes),
    },
    inCodeNotInDb: {
      constraints: minus([...declaredConstraints], new Set(prodConstraints)),
      indexes: minus([...declaredIndexes], new Set(prodIndexes)),
    },
  };
}

export function buildDriftReport(
  previous: SchemaSnapshot | null,
  current: SchemaSnapshot,
  declared: { constraints: string[]; indexes: string[] },
): DriftReport {
  const model = diffModel(previous, current);
  const codeDb = diffCodeDb(declared, current);
  const hasModelDrift =
    model.addedLabels.length > 0 ||
    model.removedLabels.length > 0 ||
    model.addedProperties.length > 0 ||
    model.removedProperties.length > 0 ||
    model.changedProperties.length > 0 ||
    model.addedRelationships.length > 0 ||
    model.removedRelationships.length > 0;
  const hasCodeDbDrift =
    codeDb.inDbNotInCode.constraints.length > 0 ||
    codeDb.inDbNotInCode.indexes.length > 0 ||
    codeDb.inCodeNotInDb.constraints.length > 0 ||
    codeDb.inCodeNotInDb.indexes.length > 0;
  return { model, codeDb, hasModelDrift, hasCodeDbDrift };
}

/** One-line status for the SCHEMA.md header badge. */
export function driftSummaryLine(report: DriftReport): string {
  const parts: string[] = [];
  if (report.hasModelDrift) {
    const m = report.model;
    const bits = [
      m.addedLabels.length + m.removedLabels.length
        ? `${m.addedLabels.length + m.removedLabels.length} label(s)`
        : '',
      m.addedProperties.length + m.removedProperties.length + m.changedProperties.length
        ? `${m.addedProperties.length + m.removedProperties.length + m.changedProperties.length} property(ies)`
        : '',
      m.addedRelationships.length + m.removedRelationships.length
        ? `${m.addedRelationships.length + m.removedRelationships.length} relationship(s)`
        : '',
    ].filter(Boolean);
    parts.push(`model changed vs last snapshot (${bits.join(', ')})`);
  }
  if (report.hasCodeDbDrift) parts.push('code↔DB drift vs schema.ts (see schema-drift.md)');
  return parts.length > 0
    ? `⚠️ ${parts.join('; ')}.`
    : '✅ In sync with the last snapshot and schema.ts.';
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((i) => `- \`${i}\``).join('\n') : '- _(none)_';
}

export function renderDriftMarkdown(report: DriftReport): string {
  const m = report.model;
  const c = report.codeDb;
  const lines: string[] = [
    '# Schema drift report',
    '',
    '_Auto-generated by `pnpm schema:diagram`. Two comparisons: model vs the last',
    'committed snapshot, and live constraints/indexes vs `src/db/schema.ts`._',
    '',
    `**Status:** ${driftSummaryLine(report)}`,
    '',
    '## Model drift (vs last committed snapshot)',
    '',
    '**Added labels**',
    bulletList(m.addedLabels),
    '',
    '**Removed labels**',
    bulletList(m.removedLabels),
    '',
    '**Added properties**',
    bulletList(m.addedProperties.map((p) => `${p.label}.${p.property} (${p.types.join('|')})`)),
    '',
    '**Removed properties**',
    bulletList(m.removedProperties.map((p) => `${p.label}.${p.property}`)),
    '',
    '**Changed property types**',
    bulletList(
      m.changedProperties.map(
        (p) => `${p.label}.${p.property}: ${p.from.join('|')} → ${p.to.join('|')}`,
      ),
    ),
    '',
    '**Added relationships**',
    bulletList(m.addedRelationships.map((r) => `(${r.from})-[:${r.type}]->(${r.to})`)),
    '',
    '**Removed relationships**',
    bulletList(m.removedRelationships.map((r) => `(${r.from})-[:${r.type}]->(${r.to})`)),
    '',
    '## Code↔DB drift (advisory)',
    '',
    'Constraint-backed indexes and `LOOKUP` token indexes are excluded as noise.',
    '',
    '**Declared in `schema.ts` but absent from the DB** (a CREATE that never applied?)',
    '',
    '_Constraints_',
    bulletList(c.inCodeNotInDb.constraints),
    '',
    '_Indexes_',
    bulletList(c.inCodeNotInDb.indexes),
    '',
    '**Present in the DB but not declared in `schema.ts`** (a stray/manual object?)',
    '',
    '_Constraints_',
    bulletList(c.inDbNotInCode.constraints),
    '',
    '_Indexes_',
    bulletList(c.inDbNotInCode.indexes),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
