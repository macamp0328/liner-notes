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
 * when unset, non-numeric, or not a positive integer.
 */
export function getStalenessDays(): number {
  const raw = process.env['ENRICHMENT_STALENESS_DAYS'];
  if (raw === undefined) return DEFAULT_STALENESS_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STALENESS_DAYS;
}
