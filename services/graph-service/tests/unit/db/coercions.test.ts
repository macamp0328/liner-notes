import { describe, it, expect } from 'vitest';
import neo4j from 'neo4j-driver';
import { toInt, toStr, toFloat } from '../../../src/db/coercions.js';

// A Neo4j Integer is duck-typed on `.toNumber()`. Cover both a real driver
// Integer and a bare stub, since callers only ever see the `.toNumber()` shape.
const stubInt = (n: number): { toNumber: () => number } => ({ toNumber: () => n });

describe('coercions — the Neo4j value boundary', () => {
  describe('toInt', () => {
    it('unwraps a real Neo4j Integer via toNumber()', () => {
      expect(toInt(neo4j.int(42))).toBe(42);
    });

    it('unwraps any toNumber-bearing object', () => {
      expect(toInt(stubInt(7))).toBe(7);
    });

    it('passes a plain number through', () => {
      expect(toInt(13)).toBe(13);
    });

    it('keeps 0 as 0, not null', () => {
      expect(toInt(0)).toBe(0);
      expect(toInt(neo4j.int(0))).toBe(0);
    });

    it('returns null for non-finite numbers (consistent with toFloat)', () => {
      expect(toInt(NaN)).toBeNull();
      expect(toInt(Infinity)).toBeNull();
      expect(toInt(-Infinity)).toBeNull();
    });

    it('returns null for null and undefined', () => {
      expect(toInt(null)).toBeNull();
      expect(toInt(undefined)).toBeNull();
    });

    it('returns null for a string (does not coerce)', () => {
      expect(toInt('5')).toBeNull();
    });

    it('returns null for an object without toNumber', () => {
      expect(toInt({})).toBeNull();
    });
  });

  describe('toFloat', () => {
    it('unwraps a real Neo4j Integer', () => {
      expect(toFloat(neo4j.int(120))).toBe(120);
    });

    it('unwraps any toNumber-bearing object', () => {
      expect(toFloat(stubInt(9.5))).toBe(9.5);
    });

    it('passes a finite number through, including 0', () => {
      expect(toFloat(118.7)).toBe(118.7);
      expect(toFloat(0)).toBe(0);
    });

    it('returns null for non-finite numbers', () => {
      expect(toFloat(NaN)).toBeNull();
      expect(toFloat(Infinity)).toBeNull();
      expect(toFloat(-Infinity)).toBeNull();
    });

    it('returns null for null and undefined', () => {
      expect(toFloat(null)).toBeNull();
      expect(toFloat(undefined)).toBeNull();
    });

    it('returns null for a string and a bare object', () => {
      expect(toFloat('1.5')).toBeNull();
      expect(toFloat({})).toBeNull();
    });
  });

  describe('toStr', () => {
    it('passes a string through, including empty', () => {
      expect(toStr('abbey road')).toBe('abbey road');
      expect(toStr('')).toBe('');
    });

    it('returns null for null and undefined', () => {
      expect(toStr(null)).toBeNull();
      expect(toStr(undefined)).toBeNull();
    });

    it('stringifies a present non-string value', () => {
      expect(toStr(42)).toBe('42');
      expect(toStr(true)).toBe('true');
    });
  });
});
