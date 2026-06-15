// Canonical data-model snapshot — the contract the whole schema-diagram tool
// hangs on. Pure: turns raw Cypher introspection rows into a sorted, count-free,
// timestamp-free object that `render.ts` draws and `drift.ts` diffs.
//
// Determinism is load-bearing: a re-run against unchanged data MUST produce a
// byte-identical snapshot, or the scheduled refresh opens a churn PR every run.
// So every list is sorted (including each property's `types`), and counts/ids are
// dropped entirely. This module imports NO driver code (see ADR 0004) so the
// offline `pnpm scripts:test` never loads `neo4j-driver`.

// --- Raw row shapes (what introspect.ts maps driver records into) ----------

/** One row from `CALL apoc.meta.nodeTypeProperties({sample:-1})`. */
export interface NodeTypePropertyRow {
  nodeLabels: string[];
  propertyName: string;
  propertyTypes: string[];
  mandatory: boolean;
}

/** One row from `MATCH (a)-[r]->(b) RETURN labels(a), type(r), labels(b)` (count dropped). */
export interface RelEndpointRow {
  from: string[];
  rel: string;
  to: string[];
}

/** One row from `SHOW CONSTRAINTS`. */
export interface ShowConstraintRow {
  name: string;
  type: string; // e.g. UNIQUENESS, NODE_KEY
  entityType: string; // NODE | RELATIONSHIP
  labelsOrTypes: string[] | null;
  properties: string[] | null;
}

/** One row from `SHOW INDEXES`. */
export interface ShowIndexRow {
  name: string;
  type: string; // indexType: RANGE | TEXT | FULLTEXT | LOOKUP | POINT
  entityType: string;
  labelsOrTypes: string[] | null;
  properties: string[] | null;
  owningConstraint: string | null; // non-null => backs a constraint
}

export interface IntrospectionRaw {
  nodeTypeRows: NodeTypePropertyRow[];
  relRows: RelEndpointRow[];
  constraintRows: ShowConstraintRow[];
  indexRows: ShowIndexRow[];
}

// --- Canonical snapshot ----------------------------------------------------

export interface PropertySchema {
  name: string;
  types: string[]; // sorted; usually length 1
  mandatory: boolean;
  unique: boolean; // derived: a uniqueness/key constraint covers (label, prop)
  indexed: boolean; // derived: a non-LOOKUP index covers (label, prop)
}

export interface LabelSchema {
  label: string;
  properties: PropertySchema[]; // sorted by name
}

export interface RelationshipSchema {
  type: string;
  from: string;
  to: string;
}

export interface ConstraintSchema {
  name: string;
  type: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[]; // declaration order preserved (composite key order matters)
}

export interface IndexSchema {
  name: string;
  indexType: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[];
  owningConstraint: string | null;
}

export interface SchemaSnapshot {
  schemaVersion: 1;
  labels: LabelSchema[];
  relationships: RelationshipSchema[];
  constraints: ConstraintSchema[];
  indexes: IndexSchema[];
}

// --- Builders (pure) -------------------------------------------------------

/** Stable string comparator — shared with drift.ts so the two pure modules sort identically. */
export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A single, stable label key for a node-type row (`&`-joined if multi-label). */
function labelKey(labels: string[]): string {
  return [...labels].sort(byString).join('&');
}

export function buildConstraints(rows: ShowConstraintRow[]): ConstraintSchema[] {
  return rows
    .map((r) => ({
      name: r.name,
      type: r.type,
      entityType: r.entityType,
      labelsOrTypes: r.labelsOrTypes ?? [],
      properties: r.properties ?? [],
    }))
    .sort((a, b) => byString(a.name, b.name));
}

export function buildIndexes(rows: ShowIndexRow[]): IndexSchema[] {
  return rows
    .map((r) => ({
      name: r.name,
      indexType: r.type,
      entityType: r.entityType,
      labelsOrTypes: r.labelsOrTypes ?? [],
      properties: r.properties ?? [],
      owningConstraint: r.owningConstraint,
    }))
    .sort((a, b) => byString(a.name, b.name));
}

/** True if some NODE uniqueness/key constraint covers (label, property).
 *  Note: a composite (multi-property) constraint marks EACH of its properties as
 *  unique independently, so the ER diagram would render a composite key as several
 *  separate PKs. No composite constraints exist today; revisit this if one is added.
 *  (`isIndexed` has the same per-property semantics for composite indexes.) */
function isUnique(label: string, property: string, constraints: ConstraintSchema[]): boolean {
  return constraints.some(
    (c) =>
      c.entityType === 'NODE' &&
      (c.type.includes('UNIQUE') || c.type.includes('KEY')) &&
      c.labelsOrTypes.includes(label) &&
      c.properties.includes(property),
  );
}

/** True if some non-LOOKUP NODE index covers (label, property). */
function isIndexed(label: string, property: string, indexes: IndexSchema[]): boolean {
  return indexes.some(
    (i) =>
      i.entityType === 'NODE' &&
      i.indexType !== 'LOOKUP' &&
      i.labelsOrTypes.includes(label) &&
      i.properties.includes(property),
  );
}

export function buildLabels(
  nodeTypeRows: NodeTypePropertyRow[],
  extraLabels: string[],
  constraints: ConstraintSchema[],
  indexes: IndexSchema[],
): LabelSchema[] {
  const byLabel = new Map<string, PropertySchema[]>();

  // Ensure every label that participates in a relationship gets an entity box,
  // even when it has no properties of its own.
  for (const label of extraLabels) {
    if (!byLabel.has(label)) byLabel.set(label, []);
  }

  for (const row of nodeTypeRows) {
    const label = labelKey(row.nodeLabels);
    const props = byLabel.get(label) ?? [];
    props.push({
      name: row.propertyName,
      types: [...row.propertyTypes].sort(byString),
      mandatory: row.mandatory,
      // Derive against any of the row's raw labels (multi-label nodes won't match
      // single-label constraints — acceptable, and warned about upstream).
      unique: row.nodeLabels.some((l) => isUnique(l, row.propertyName, constraints)),
      indexed: row.nodeLabels.some((l) => isIndexed(l, row.propertyName, indexes)),
    });
    byLabel.set(label, props);
  }

  return [...byLabel.entries()]
    .map(([label, properties]) => ({
      label,
      properties: properties.sort((a, b) => byString(a.name, b.name)),
    }))
    .sort((a, b) => byString(a.label, b.label));
}

export function buildRelationships(rows: RelEndpointRow[]): RelationshipSchema[] {
  const seen = new Map<string, RelationshipSchema>();
  for (const row of rows) {
    const from = labelKey(row.from);
    const to = labelKey(row.to);
    if (from === '' || to === '') continue; // a relationship with an unlabeled endpoint
    const rel: RelationshipSchema = { type: row.rel, from, to };
    seen.set(`${rel.type} ${rel.from} ${rel.to}`, rel);
  }
  return [...seen.values()].sort(
    (a, b) => byString(a.type, b.type) || byString(a.from, b.from) || byString(a.to, b.to),
  );
}

export function buildSnapshot(raw: IntrospectionRaw): SchemaSnapshot {
  const constraints = buildConstraints(raw.constraintRows);
  const indexes = buildIndexes(raw.indexRows);
  const relationships = buildRelationships(raw.relRows);

  // Labels referenced only by relationships still need an entity box.
  const relLabels = new Set<string>();
  for (const r of relationships) {
    relLabels.add(r.from);
    relLabels.add(r.to);
  }

  const labels = buildLabels(raw.nodeTypeRows, [...relLabels], constraints, indexes);

  return { schemaVersion: 1, labels, relationships, constraints, indexes };
}

/** Canonical JSON the generator writes (prettier reformats it afterward). */
export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
