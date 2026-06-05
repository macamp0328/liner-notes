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
 * This is the shared coercion surface for the read repositories (collection,
 * explore, search, stats). It replaced three drifted per-repository copies whose
 * `toInt`, `toStr` and `toFloat` had diverged into subtly different behaviours.
 * The enrichment repositories still inline their own `.toNumber()` coercions;
 * consolidating those is out of scope here (see the enrichment-pipeline
 * deepening, #222).
 */

/** A Neo4j `Integer`: a 64-bit int carried as an object with `.toNumber()`. */
export type Neo4jInt = { toNumber(): number };

function hasToNumber(v: unknown): v is Neo4jInt {
  return typeof (v as Partial<Neo4jInt> | null | undefined)?.toNumber === 'function';
}

/** Neo4j Integer or finite number → number; null/undefined/anything else → null. */
export function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (hasToNumber(v)) return v.toNumber();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * Integer-column variant of {@link toFloat} — identical narrowing, kept as a
 * separate name to signal the caller expects an integer-valued column
 * (discogsId, counts, years). Shares toFloat's body so the two cannot drift,
 * which includes rejecting non-finite numbers (NaN / ±Infinity → null).
 */
export function toInt(v: unknown): number | null {
  return toFloat(v);
}

/** Any present value → its string form; null/undefined → null. */
export function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
