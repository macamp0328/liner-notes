// Canonical write-path chokepoints for the multi-writer controlled-vocabulary nodes
// `Country` and `Studio` (ADR 0005, law 6: "one canonical write path per multi-writer entity").
//
// Both labels are written by several repositories. Before this module each writer spelled its own
// raw `MERGE (:Country …)` / `MERGE (:Studio …)`, so identity rules (normalization, the merge key)
// drifted writer-to-writer — the proven cause of the GB/UK Country fragmentation in ADR 0005's
// audit. These helpers make the node MERGE clause come from ONE place; a `src/db/**` guard test
// (tests/unit/db/canonical-write-paths.guard.test.ts) fails CI if a raw clause reappears elsewhere.
//
// They return the Cypher MERGE *clause string* (not an executing call) so each writer interpolates
// it into its existing query, preserving single-query/`UNWIND`-batched/multi-edge structure — this
// is a structure-only refactor with byte-identical graph output. The same pure-string-helper shape
// as `lucene.ts`'s `escapeLuceneQuery`.
//
// SCOPE (ADR 0005): this is the *syntactic* chokepoint only. Normalization is deliberately NOT here
// yet — Discogs→ISO Country normalization (sub-issue 2) and Studio trim/case-fold (sub-issue 4) land
// inside these helpers later, at which point every writer inherits them for free. Today the clause
// is value-preserving.

/**
 * Canonical `(:Country)` node MERGE — the single write path for Country (ADR 0005, law 6).
 *
 * @param nameExpr a Cypher expression evaluating to the country name — a query parameter
 *   (`'$countryCode'`) or an `UNWIND` field (`'item.country'`).
 * @param nodeVar the bound node variable (defaults to `c`, matching every current call site).
 */
export function mergeCountryClause(nameExpr: string, nodeVar = 'c'): string {
  return `MERGE (${nodeVar}:Country {name: ${nameExpr}})`;
}

/**
 * Canonical `(:Studio)` node MERGE — the single write path for Studio (ADR 0005, law 6).
 *
 * @param nameExpr a Cypher expression evaluating to the studio name — a query parameter (`'$name'`)
 *   or an `UNWIND` field (`'p.name'`).
 * @param nodeVar the bound node variable (defaults to `s`, matching every current call site).
 */
export function mergeStudioClause(nameExpr: string, nodeVar = 's'): string {
  return `MERGE (${nodeVar}:Studio {name: ${nameExpr}})`;
}
