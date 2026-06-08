/**
 * Staleness window for re-enriching nodes whose external-source lookup previously
 * returned no data. Enrichment candidate queries skip a node that already has the
 * data, and re-attempt a still-missing node at most once per this window — so a
 * source that gains coverage (or a client we later fix) is picked up automatically
 * without a full re-ingest. See issue #89.
 */

const DEFAULT_STALENESS_DAYS = 30;

/**
 * Resolve the re-enrichment staleness window in days from the
 * `ENRICHMENT_STALENESS_DAYS` env var, falling back to {@link DEFAULT_STALENESS_DAYS}
 * when unset, non-numeric, or negative.
 *
 * `0` is a valid, honored value: the candidate query's window collapses to
 * `lastFetchedAt < datetime() - duration({ days: 0 })`, i.e. `lastFetchedAt < datetime()`.
 * Enrichment stamps `*FetchedAt` server-side via `datetime()`, so a stamped node's timestamp is
 * already in the past by the time a later query runs — which is why, in practice, every
 * still-missing node is re-attempted regardless of its last attempt (a node could only be
 * skipped by a `lastFetchedAt` at or after the query's own `datetime()`, which the server-side
 * stamping never produces). This is what the operator-run local Genius lyrics harvest sets so it
 * isn't throttled by prod's prior `lyricsFetchedAt` stamps (#258). Prod leaves the var unset (→ 30).
 */
export function getStalenessDays(): number {
  const raw = process.env['ENRICHMENT_STALENESS_DAYS'];
  if (raw === undefined) return DEFAULT_STALENESS_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_STALENESS_DAYS;
}
