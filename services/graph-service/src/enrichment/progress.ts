/**
 * Reports loop progress from a long-running enrichment.
 *
 * `processed`/`total` are item counts in whatever unit the loop iterates — usually
 * tracks/artists/masters, but for the dedup loops it is the deduplicated unit (unique
 * MBIDs for AcousticBrainz, unique ISRCs for Deezer). Call it cheaply, at the loop's
 * existing log cadence (every 10/25/50 items) — never per item.
 */
export type ProgressReporter = (processed: number, total: number) => void;

/** Default reporter for callers that don't track progress (e.g. the standalone /enrich routes). */
export const NOOP_PROGRESS: ProgressReporter = () => {};
