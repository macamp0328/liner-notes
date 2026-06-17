// Canonical write-path chokepoints for the multi-writer controlled-vocabulary nodes
// `Country`, `Region` and `Studio` (ADR 0005, law 6: "one canonical write path per multi-writer
// entity").
//
// These labels are written by several repositories. Before this module each writer spelled its own
// raw `MERGE (:Country …)` / `MERGE (:Studio …)`, so identity rules (normalization, the merge key)
// drifted writer-to-writer — the proven cause of the GB/UK Country fragmentation in ADR 0005's
// audit. These helpers make the node MERGE clause come from ONE place; a `src/db/**` guard test
// (tests/unit/db/canonical-write-paths.guard.test.ts) fails CI if a raw clause reappears elsewhere.
//
// They return the Cypher MERGE *clause string* (not an executing call) so each writer interpolates
// it into its existing query, preserving single-query/`UNWIND`-batched/multi-edge structure. The same
// pure-string-helper shape as `lucene.ts`'s `escapeLuceneQuery`.
//
// SCOPE (ADR 0005): these helpers are the node-MERGE chokepoint; WHERE the normalization lives differs
// by entity. Studio canonicalization (sub-issue 4, #443) is folded straight into `mergeStudioClause`
// (a `nameKey` fold, see below), so every Studio writer inherits it for free. Country normalization
// can't live in the clause — a string can't fan one raw market into a `:Country` MERGE *and* a
// `:Region` MERGE — so it lives in `normalizeCountry` (transforms.ts, sub-issue 2, #441), applied
// per-writer in TS before the UNWIND payload is built. `mergeCountryClause`/`mergeRegionClause` stay
// value-preserving clause builders.

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
 * Canonical `(:Region)` node MERGE — the single write path for Region (ADR 0005, law 6). Regions are
 * the non-country market tokens (`EU`, `WW`, `Scandinavia`, compound markets) split off so `:Country`
 * stays pure ISO 3166-1 alpha-2. Tokens come from `normalizeCountry(...).regions`.
 *
 * @param nameExpr a Cypher expression evaluating to the region name — a query parameter or an
 *   `UNWIND` field (`'row.code'`).
 * @param nodeVar the bound node variable (defaults to `g`, avoiding the `c`/`r`/`s` collisions the
 *   region writers' surrounding queries already bind).
 */
export function mergeRegionClause(nameExpr: string, nodeVar = 'g'): string {
  return `MERGE (${nodeVar}:Region {name: ${nameExpr}})`;
}

/**
 * Canonical `(:Studio)` node MERGE — the single write path for Studio (ADR 0005, law 6 + sub-issue 4,
 * #443). Studio is name-keyed (no Discogs/MB id), so both writers MERGE the same physical studio. To
 * stop case/space variants ("EastWest" vs "Eastwest") fragmenting into separate nodes, the merge keys
 * on a folded `nameKey = toLower(trim(name))` (backed by a UNIQUE constraint in `schema.ts`); the
 * human-readable `name` is preserved verbatim (trimmed, NOT lowercased) via `ON CREATE SET`, so the
 * first writer to create the node sets the display value and later writers reuse it. Read paths that
 * surface the name (the map, the connections graph) keep showing readable casing.
 *
 * @param nameExpr a Cypher expression evaluating to the studio name — a query parameter (`'$name'`)
 *   or an `UNWIND` field (`'p.name'`).
 * @param nodeVar the bound node variable (defaults to `s`, matching every current call site).
 */
export function mergeStudioClause(nameExpr: string, nodeVar = 's'): string {
  return `MERGE (${nodeVar}:Studio {nameKey: toLower(trim(${nameExpr}))}) ON CREATE SET ${nodeVar}.name = trim(${nameExpr})`;
}
