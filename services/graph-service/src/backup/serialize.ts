/**
 * serialize.ts — the pure backup codec (issue #104). No I/O; both directions live here so
 * export (encode) and restore (decode) can never drift.
 *
 * FORMAT: JSON Lines. Neo4j property values can only be primitives, temporal/spatial types,
 * byte arrays, or homogeneous arrays thereof — never maps — so a JSON *object* in the encoded
 * form is unambiguously a type tag (`{ $t, v }`) with no possible collision with real data.
 *
 * FIDELITY RULES (the acceptance bar is lossless round-trip):
 * - Integers are ALWAYS tagged, with the value as a decimal string — exact past 2^53. An
 *   untagged JSON number therefore always decodes to a Neo4j float, a tagged one to an
 *   integer, so the driver's float/int distinction survives the trip.
 * - Temporal types are encoded as their own structured fields (not ISO strings): copying the
 *   driver object's integer fields is trivially lossless (nanoseconds, offset AND zone id all
 *   preserved) and decode is a constructor call — no parser to get wrong.
 * - encode(decode(x)) === encode(x) — decoding then re-encoding is byte-identical, which is
 *   what the round-trip tests assert (the driver objects themselves differ in Integer-vs-number
 *   field representation, so structural equality is checked on the encoded form).
 */
import neo4j from 'neo4j-driver';
import type { Node, Relationship } from 'neo4j-driver';

export const FORMAT_VERSION = 1;

export type EncodedValue = string | number | boolean | null | EncodedValue[] | TaggedValue;

export interface TaggedValue {
  $t: string;
  v: unknown;
}

export type EncodedProps = Record<string, EncodedValue>;

export interface MetadataLine {
  type: 'metadata';
  formatVersion: number;
  exportedAt: string;
  sourceHost: string;
}

export interface NodeLine {
  type: 'node';
  /** elementId — an intra-file correlation key only; no cross-run stability is assumed. */
  id: string;
  labels: string[];
  props: EncodedProps;
}

export interface RelLine {
  type: 'rel';
  id: string;
  relType: string;
  start: string;
  end: string;
  props: EncodedProps;
}

export interface ManifestLine {
  type: 'manifest';
  nodeCount: number;
  relCount: number;
  /** Keyed by sorted label set (see {@link labelSetKey}) — display/verification only. */
  labelCounts: Record<string, number>;
  relTypeCounts: Record<string, number>;
}

export type BackupLine = MetadataLine | NodeLine | RelLine | ManifestLine;

/** Stable grouping/count key for a node's label set. */
export function labelSetKey(labels: string[]): string {
  return labels.length === 0 ? '(none)' : [...labels].sort().join(':');
}

/** Temporal-type fields arrive as neo4j Integers (lossless mode) or numbers — normalize. */
function fieldNum(value: unknown): number {
  if (typeof value === 'number') return value;
  if (neo4j.isInt(value as never)) return (value as { toNumber(): number }).toNumber();
  return Number(value);
}

function pickFields(source: object, names: string[]): Record<string, number> {
  return Object.fromEntries(
    names.flatMap((name): [string, number][] => {
      // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded field-name literal from this module's own call sites, never input data
      const raw = (source as Record<string, unknown>)[name];
      return raw === undefined || raw === null ? [] : [[name, fieldNum(raw)]];
    }),
  );
}

export function encodeValue(value: unknown): EncodedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value; // untagged number = Neo4j float
  if (Array.isArray(value)) return value.map(encodeValue);
  if (neo4j.isInt(value as never)) {
    return { $t: 'int', v: (value as { toString(): string }).toString() };
  }
  if (neo4j.isDateTime(value as never)) {
    const d = value as unknown as { timeZoneId?: string };
    const fields: Record<string, unknown> = pickFields(d as object, [
      'year',
      'month',
      'day',
      'hour',
      'minute',
      'second',
      'nanosecond',
      'timeZoneOffsetSeconds',
    ]);
    if (d.timeZoneId !== undefined && d.timeZoneId !== null) fields['timeZoneId'] = d.timeZoneId;
    return { $t: 'datetime', v: fields };
  }
  if (neo4j.isLocalDateTime(value as never)) {
    return {
      $t: 'localdatetime',
      v: pickFields(value as object, [
        'year',
        'month',
        'day',
        'hour',
        'minute',
        'second',
        'nanosecond',
      ]),
    };
  }
  if (neo4j.isDate(value as never)) {
    return { $t: 'date', v: pickFields(value as object, ['year', 'month', 'day']) };
  }
  if (neo4j.isTime(value as never)) {
    return {
      $t: 'time',
      v: pickFields(value as object, [
        'hour',
        'minute',
        'second',
        'nanosecond',
        'timeZoneOffsetSeconds',
      ]),
    };
  }
  if (neo4j.isLocalTime(value as never)) {
    return {
      $t: 'localtime',
      v: pickFields(value as object, ['hour', 'minute', 'second', 'nanosecond']),
    };
  }
  if (neo4j.isDuration(value as never)) {
    return {
      $t: 'duration',
      v: pickFields(value as object, ['months', 'days', 'seconds', 'nanoseconds']),
    };
  }
  if (neo4j.isPoint(value as never)) {
    return { $t: 'point', v: pickFields(value as object, ['srid', 'x', 'y', 'z']) };
  }
  if (value instanceof Uint8Array) {
    return { $t: 'bytes', v: Buffer.from(value).toString('base64') };
  }
  throw new Error(`Cannot encode property value of unsupported type: ${describe(value)}`);
}

function describe(value: unknown): string {
  const ctor = (value as { constructor?: { name?: string } })?.constructor?.name;
  return ctor ?? typeof value;
}

/**
 * Every JSON object in a well-formed backup is a `{ $t, v }` type tag (Neo4j props are never
 * maps, so no collision is possible). An object WITHOUT a string `$t` is therefore corrupt
 * input — throw a pointed error rather than falling through to a confusing
 * `unknown type tag "undefined"` or, worse, passing the raw object to the driver.
 */
function asTagged(value: object): TaggedValue {
  const tag = (value as Record<string, unknown>)['$t'];
  if (typeof tag !== 'string') {
    throw new Error(
      'Malformed encoded value: JSON object without a string "$t" type tag — corrupt backup file?',
    );
  }
  return value as TaggedValue;
}

function vNum(fields: unknown, name: string): number {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded field-name literal from decodeValue, never input data
  const raw = (fields as Record<string, unknown>)[name];
  if (typeof raw !== 'number') {
    throw new Error(`Malformed tagged value: expected numeric field "${name}"`);
  }
  return raw;
}

function vNumOpt(fields: unknown, name: string): number | undefined {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded field-name literal from decodeValue, never input data
  const raw = (fields as Record<string, unknown>)[name];
  return typeof raw === 'number' ? raw : undefined;
}

export function decodeValue(value: EncodedValue): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) return value.map(decodeValue);
  const { $t, v } = asTagged(value);
  switch ($t) {
    case 'int': {
      if (typeof v !== 'string') throw new Error('Malformed int tag: value must be a string');
      return neo4j.int(v);
    }
    case 'datetime': {
      const tz = (v as Record<string, unknown>)['timeZoneId'];
      return new neo4j.types.DateTime(
        vNum(v, 'year'),
        vNum(v, 'month'),
        vNum(v, 'day'),
        vNum(v, 'hour'),
        vNum(v, 'minute'),
        vNum(v, 'second'),
        vNum(v, 'nanosecond'),
        vNumOpt(v, 'timeZoneOffsetSeconds'),
        typeof tz === 'string' ? tz : undefined,
      );
    }
    case 'localdatetime':
      return new neo4j.types.LocalDateTime(
        vNum(v, 'year'),
        vNum(v, 'month'),
        vNum(v, 'day'),
        vNum(v, 'hour'),
        vNum(v, 'minute'),
        vNum(v, 'second'),
        vNum(v, 'nanosecond'),
      );
    case 'date':
      return new neo4j.types.Date(vNum(v, 'year'), vNum(v, 'month'), vNum(v, 'day'));
    case 'time':
      return new neo4j.types.Time(
        vNum(v, 'hour'),
        vNum(v, 'minute'),
        vNum(v, 'second'),
        vNum(v, 'nanosecond'),
        vNum(v, 'timeZoneOffsetSeconds'),
      );
    case 'localtime':
      return new neo4j.types.LocalTime(
        vNum(v, 'hour'),
        vNum(v, 'minute'),
        vNum(v, 'second'),
        vNum(v, 'nanosecond'),
      );
    case 'duration':
      return new neo4j.types.Duration(
        vNum(v, 'months'),
        vNum(v, 'days'),
        vNum(v, 'seconds'),
        vNum(v, 'nanoseconds'),
      );
    case 'point': {
      const z = vNumOpt(v, 'z');
      return z === undefined
        ? new neo4j.types.Point(neo4j.int(vNum(v, 'srid')), vNum(v, 'x'), vNum(v, 'y'))
        : new neo4j.types.Point(neo4j.int(vNum(v, 'srid')), vNum(v, 'x'), vNum(v, 'y'), z);
    }
    case 'bytes': {
      if (typeof v !== 'string') throw new Error('Malformed bytes tag: value must be a string');
      return new Uint8Array(Buffer.from(v, 'base64'));
    }
    default:
      throw new Error(`Cannot decode unknown type tag "${$t}"`);
  }
}

// Both prop mappers build via Object.fromEntries, which defines own properties directly —
// a hostile key like "__proto__" in a backup file can't reach the prototype setter.
export function encodeProps(properties: Record<string, unknown>): EncodedProps {
  return Object.fromEntries(
    Object.entries(properties).map(([key, raw]) => [key, encodeValue(raw)]),
  );
}

export function decodeProps(props: EncodedProps): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).map(([key, raw]) => [key, decodeValue(raw)]));
}

export function encodeNode(node: Node): NodeLine {
  return {
    type: 'node',
    id: node.elementId,
    labels: [...node.labels],
    props: encodeProps(node.properties as Record<string, unknown>),
  };
}

export function encodeRelationship(rel: Relationship): RelLine {
  return {
    type: 'rel',
    id: rel.elementId,
    relType: rel.type,
    start: rel.startNodeElementId,
    end: rel.endNodeElementId,
    props: encodeProps(rel.properties as Record<string, unknown>),
  };
}
