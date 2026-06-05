/**
 * Value coercion across the Neo4j driver boundary.
 *
 * The driver returns 64-bit integers as `Integer` objects (carrying a
 * `.toNumber()` method), floats and other scalars as plain JS values, and absent
 * values as `null`. These helpers narrow a raw `record.get(...)` into a plain JS
 * value. Anything that isn't a recognisable number/string becomes `null` — so a
 * wrong column surfaces as `null` (caught by a call-site `?? default`) rather
 * than a mistyped value flowing on undetected.
 *
 * This is the single source of truth for that boundary. It replaced three
 * drifted per-repository copies (collection / explore / search) whose `toInt`,
 * `toStr` and `toFloat` had diverged into subtly different behaviours.
 */

/** A Neo4j `Integer`: a 64-bit int carried as an object with `.toNumber()`. */
export type Neo4jInt = { toNumber(): number };

function hasToNumber(v: unknown): v is Neo4jInt {
  return typeof (v as Partial<Neo4jInt> | null | undefined)?.toNumber === 'function';
}

/** Neo4j Integer or plain number → number; null/undefined/anything else → null. */
export function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (hasToNumber(v)) return v.toNumber();
  if (typeof v === 'number') return v;
  return null;
}

/** Neo4j Integer or finite number → number; null/undefined/anything else → null. */
export function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (hasToNumber(v)) return v.toNumber();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Any present value → its string form; null/undefined → null. */
export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
