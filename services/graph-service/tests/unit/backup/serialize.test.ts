import { describe, it, expect } from 'vitest';
import neo4j from 'neo4j-driver';
import {
  FORMAT_VERSION,
  encodeValue,
  decodeValue,
  encodeProps,
  decodeProps,
  encodeNode,
  encodeRelationship,
  labelSetKey,
  type TaggedValue,
} from '../../../src/backup/serialize.js';

/** The load-bearing invariant: decode → re-encode is byte-identical to the original encoding. */
function roundTrip(value: unknown): void {
  const encoded = encodeValue(value);
  const reEncoded = encodeValue(decodeValue(encoded));
  expect(reEncoded).toEqual(encoded);
}

describe('encodeValue / decodeValue', () => {
  it('passes primitives through untouched', () => {
    expect(encodeValue('a string')).toBe('a string');
    expect(encodeValue(true)).toBe(true);
    expect(encodeValue(null)).toBeNull();
    expect(encodeValue(undefined)).toBeNull();
    expect(decodeValue('a string')).toBe('a string');
    expect(decodeValue(false)).toBe(false);
    expect(decodeValue(null)).toBeNull();
  });

  it('keeps floats as plain JSON numbers that decode back to plain numbers', () => {
    expect(encodeValue(0.85)).toBe(0.85);
    expect(decodeValue(0.85)).toBe(0.85);
    // 2.0 the float stays an untagged number — never confused with int(2)
    expect(encodeValue(2.0)).toBe(2);
    expect(decodeValue(2)).toBe(2);
  });

  it('tags Integers and round-trips them exactly, including values past 2^53', () => {
    const encoded = encodeValue(neo4j.int(42)) as TaggedValue;
    expect(encoded).toEqual({ $t: 'int', v: '42' });
    const decoded = decodeValue(encoded);
    expect(neo4j.isInt(decoded as never)).toBe(true);
    expect((decoded as { toNumber(): number }).toNumber()).toBe(42);

    const big = neo4j.int('9007199254740995'); // > Number.MAX_SAFE_INTEGER
    const bigEncoded = encodeValue(big) as TaggedValue;
    expect(bigEncoded.v).toBe('9007199254740995');
    expect((decodeValue(bigEncoded) as { toString(): string }).toString()).toBe('9007199254740995');
  });

  it('discriminates float 2.0 from int(2)', () => {
    expect(encodeValue(2.0)).toBe(2);
    expect(encodeValue(neo4j.int(2))).toEqual({ $t: 'int', v: '2' });
  });

  it('round-trips DateTime with a named zone and nanoseconds losslessly', () => {
    const dt = new neo4j.types.DateTime(
      2026,
      7,
      16,
      1,
      2,
      3,
      456789012,
      -14400,
      'America/New_York',
    );
    const encoded = encodeValue(dt) as TaggedValue;
    expect(encoded.$t).toBe('datetime');
    expect(encoded.v).toEqual({
      year: 2026,
      month: 7,
      day: 16,
      hour: 1,
      minute: 2,
      second: 3,
      nanosecond: 456789012,
      timeZoneOffsetSeconds: -14400,
      timeZoneId: 'America/New_York',
    });
    const decoded = decodeValue(encoded);
    expect(neo4j.isDateTime(decoded as never)).toBe(true);
    expect(String(decoded)).toBe(String(dt));
    roundTrip(dt);
  });

  it('round-trips DateTime with an offset only (no zone id)', () => {
    const dt = new neo4j.types.DateTime(2026, 1, 1, 0, 0, 0, 0, 0, undefined);
    const encoded = encodeValue(dt) as TaggedValue;
    expect((encoded.v as Record<string, unknown>)['timeZoneId']).toBeUndefined();
    roundTrip(dt);
  });

  it('round-trips Date, LocalDateTime, Time, LocalTime, and Duration', () => {
    roundTrip(new neo4j.types.Date(1969, 7, 20));
    roundTrip(new neo4j.types.LocalDateTime(2026, 7, 16, 12, 30, 0, 999));
    roundTrip(new neo4j.types.Time(23, 59, 59, 1, 3600));
    roundTrip(new neo4j.types.LocalTime(6, 30, 0, 0));
    roundTrip(new neo4j.types.Duration(1, 2, 3, 4));
  });

  it('round-trips 2D and 3D Points with srid', () => {
    const p2 = new neo4j.types.Point(neo4j.int(4326), -73.97, 40.64);
    const p3 = new neo4j.types.Point(neo4j.int(4979), -73.97, 40.64, 12.5);
    expect((encodeValue(p2) as TaggedValue).v).toEqual({ srid: 4326, x: -73.97, y: 40.64 });
    expect((encodeValue(p3) as TaggedValue).v).toEqual({
      srid: 4979,
      x: -73.97,
      y: 40.64,
      z: 12.5,
    });
    roundTrip(p2);
    roundTrip(p3);
  });

  it('round-trips byte arrays via base64', () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const encoded = encodeValue(bytes) as TaggedValue;
    expect(encoded.$t).toBe('bytes');
    expect(decodeValue(encoded)).toEqual(bytes);
  });

  it('recurses arrays, including arrays of temporals and ints', () => {
    const arr = ['a', neo4j.int(7), new neo4j.types.Date(2001, 9, 11), 1.5];
    roundTrip(arr);
    const encoded = encodeValue(arr) as unknown[];
    expect(encoded[0]).toBe('a');
    expect(encoded[1]).toEqual({ $t: 'int', v: '7' });
    expect(encoded[3]).toBe(1.5);
  });

  it('throws on an unsupported encode type and an unknown decode tag', () => {
    expect(() => encodeValue(new Map())).toThrow(/unsupported type/);
    expect(() => decodeValue({ $t: 'wat', v: 1 })).toThrow(/unknown type tag "wat"/);
    expect(() => decodeValue({ $t: 'int', v: 42 } as never)).toThrow(/must be a string/);
  });
});

describe('encodeProps / decodeProps', () => {
  it('maps every property through the codec', () => {
    const props = { title: 'Blue', year: neo4j.int(1971), confidence: 0.92 };
    const encoded = encodeProps(props);
    expect(encoded).toEqual({ title: 'Blue', year: { $t: 'int', v: '1971' }, confidence: 0.92 });
    const decoded = decodeProps(encoded);
    expect(decoded['title']).toBe('Blue');
    expect((decoded['year'] as { toNumber(): number }).toNumber()).toBe(1971);
  });
});

describe('encodeNode / encodeRelationship', () => {
  it('produces the JSONL line shapes from driver graph types', () => {
    const node = new neo4j.types.Node(
      neo4j.int(1),
      ['Release', 'Special'],
      { title: 'Kind of Blue' },
      '4:abc:1',
    );
    expect(encodeNode(node as never)).toEqual({
      type: 'node',
      id: '4:abc:1',
      labels: ['Release', 'Special'],
      props: { title: 'Kind of Blue' },
    });

    const rel = new neo4j.types.Relationship(
      neo4j.int(9),
      neo4j.int(1),
      neo4j.int(2),
      'CREDITED_ON',
      { role: 'Bass' },
      '5:abc:9',
      '4:abc:1',
      '4:abc:2',
    );
    expect(encodeRelationship(rel as never)).toEqual({
      type: 'rel',
      id: '5:abc:9',
      relType: 'CREDITED_ON',
      start: '4:abc:1',
      end: '4:abc:2',
      props: { role: 'Bass' },
    });
  });
});

describe('labelSetKey', () => {
  it('sorts labels and names the empty set', () => {
    expect(labelSetKey(['Musician', 'Artist'])).toBe('Artist:Musician');
    expect(labelSetKey([])).toBe('(none)');
  });
});

describe('FORMAT_VERSION', () => {
  it('is 1 — bump requires a restore-side reader for the new shape', () => {
    expect(FORMAT_VERSION).toBe(1);
  });
});
