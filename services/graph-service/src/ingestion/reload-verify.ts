import type { CoverageMetric, StatsData } from '../db/stats-repository.js';
import type { ReloadStageName } from './stages.js';

/**
 * Keys under `StatsData.enrichment` whose value is a CoverageMetric (or the SourcedCoverageMetric
 * subtype) — i.e. the gateable coverage figures. Excludes `lyricsFunnel`, which is a raw
 * four-state count, not a covered/applicable metric (#246).
 */
type CoverageMetricKey = {
  [K in keyof StatsData['enrichment']]: StatsData['enrichment'][K] extends CoverageMetric
    ? K
    : never;
}[keyof StatsData['enrichment']];

/**
 * One coverage bar the reload must clear. `metric` names a coverage key under
 * `StatsData.enrichment`; `stage` is the reload stage that produces it (so a
 * failure can name the offending stage); `minPct` is the inclusive floor the
 * metric's `pct` must reach. `minPct: 0` means "silently-zero protection only" —
 * no percentage floor, only a non-empty result is required.
 */
export interface CoverageThreshold {
  metric: CoverageMetricKey;
  stage: ReloadStageName;
  minPct: number;
}

/**
 * The single source of truth for reload coverage bars. Changing a bar is a
 * one-line edit here, reused by the verify gate and its tests.
 *
 * Pinned by #165: originalYear ≥ 90%, artistsWithProfile ≥ 80%. Track-level
 * (recordingMbid/isrc) confirmed lenient by the operator. lyrics/tempo/deezerBpm
 * are best-effort external sources — gated for "populated" (silently-zero) only.
 *
 * Deliberately omitted: genres, styles, nationality, releaseEvents,
 * deezerGain, Wikidata bio (#341), tracksWithMbProductionCredits + tracksWithMbArrangers (#339), and
 * tracksWithMbStudio (#339 slice 2). They are not in #178's scope; add a row here to start gating one.
 * Wikidata bio is
 * intentionally ungated like nationality: it is a best-effort external source that can legitimately
 * resolve zero (transient outage, an obscure collection), so a silently-zero floor would false-fail
 * an otherwise healthy reload. tracksWithMbProductionCredits and tracksWithMbArrangers are the same
 * case: recording-level production/arranging credits can legitimately be near-zero (MusicBrainz
 * frequently models production at the release level, and arranging is sparse), and the shared
 * MB-track-credit chain is already silently-zero-guarded by tracksWithMbRecordingArtists (same fetch +
 * write path), so a production/arranger floor would only add false-failure risk. tracksWithMbStudio is the most extreme case: MusicBrainz recording→place
 * relations are genuinely rare, and — unlike the production subset — this stage has its OWN
 * `inc=place-rels` fetch, so there is no sibling silently-zero guard to ride. A minPct:0 floor would
 * therefore false-fail any healthy reload whose collection simply has no MB studio data; its
 * broken-fetch tripwire is the client parse unit test instead (a wrong JSON path can't extract a
 * studio). Coverage is a known number on `/stats`, not a gate.
 */
export const RELOAD_COVERAGE_THRESHOLDS: readonly CoverageThreshold[] = [
  { metric: 'releasesWithOriginalYear', stage: 'master-data', minPct: 90 },
  { metric: 'artistsWithProfile', stage: 'artist-profiles', minPct: 80 },
  { metric: 'tracksWithLyrics', stage: 'lyrics', minPct: 0 },
  { metric: 'tracksWithRecordingMbid', stage: 'track-musicbrainz', minPct: 50 },
  { metric: 'tracksWithIsrc', stage: 'track-musicbrainz', minPct: 40 },
  // #336: MusicBrainz Work coverage is best-effort (not every recording has a work relationship),
  // so gate for "populated" (silently-zero) only, like lyrics/tempo.
  { metric: 'tracksWithWork', stage: 'track-works', minPct: 0 },
  // #335: track credits pushed down from MB recording artist-rels are best-effort (not every
  // recording has performance relations), so gate for "populated" (silently-zero) only, like
  // tracksWithWork. applicable is the upstream gate (tracks with a recordingMbid), so a broken
  // chain — no recordings fetched, or every performer unresolved — fails the reload loud.
  { metric: 'tracksWithMbRecordingArtists', stage: 'track-recording-artists', minPct: 0 },
  { metric: 'tracksWithTempo', stage: 'track-acousticbrainz', minPct: 0 },
  { metric: 'tracksWithDeezerBpm', stage: 'track-deezer', minPct: 0 },
  // #330: reconciliation is deterministic + exhaustive (Artist.discogsId is unique), so after it
  // runs covered == applicable exactly. minPct:100 (not 0) is therefore the meaningful floor — a
  // 0 floor would be decorative, since the inline mergeSamePersonAs already guarantees covered>0.
  // verify runs strictly last and no stage creates Musicians after reconciliation, so it's a clean
  // post-condition: any missing late-Artist link → covered<applicable → reload failed.
  { metric: 'samePersonLinks', stage: 'person-reconciliation', minPct: 100 },
  // #380: WROTE coverage is best-effort (a Work's writers must also be in-collection nodes with a
  // resolved MBID to link), so gate for "populated" (silently-zero) only, like tracksWithWork. A
  // true zero is implausible for a real collection — self-penned songs guarantee covered>0 — so a
  // silently-zero here flags a broken chain (no MBIDs stored, or reconciliation matching nothing).
  { metric: 'worksWithWriterLinks', stage: 'songwriter-reconciliation', minPct: 0 },
];

/** Why a metric passed or failed — drives the human-readable failure summary. */
export type VerifyReason =
  'ok' | 'not-applicable' | 'not-run' | 'silently-zero' | 'below-threshold' | 'empty-graph';

export interface MetricVerdict {
  metric: string;
  stage: ReloadStageName;
  covered: number;
  applicable: number;
  pct: number | null;
  threshold: number;
  pass: boolean;
  reason: VerifyReason;
}

export interface VerifyReport {
  pass: boolean;
  metrics: MetricVerdict[];
  /** Distinct stages with at least one failing metric — what to investigate. */
  failingStages: ReloadStageName[];
}

function evaluateMetric(
  t: CoverageThreshold,
  m: CoverageMetric,
  ranStages: ReadonlySet<ReloadStageName>,
): MetricVerdict {
  const base = {
    metric: t.metric,
    stage: t.stage,
    covered: m.covered,
    applicable: m.applicable,
    pct: m.pct,
    threshold: t.minPct,
  };
  // The producing stage did not run this job (skipped — e.g. its client was not
  // configured). No output was expected, so the metric is exempt rather than a
  // false silently-zero. This is what keeps a forkable, no-MusicBrainz
  // deployment from failing every reload on recordingMbid/isrc (applicable = all
  // tracks, so it would not self-exempt via applicable === 0).
  if (!ranStages.has(t.stage)) {
    return { ...base, pass: true, reason: 'not-run' };
  }
  // Genuinely nothing to enrich (e.g. no release has a master → originalYear
  // applicable 0). Reporting 0% here would be misleading, not a failure.
  if (m.applicable === 0) {
    return { ...base, pass: true, reason: 'not-applicable' };
  }
  // The #151 bug: the stage ran against real candidates and produced nothing.
  if (m.covered === 0) {
    return { ...base, pass: false, reason: 'silently-zero' };
  }
  // Below the pinned floor (inclusive — exactly at the floor passes). Compare the
  // exact covered/applicable counts, not getStats's `pct` (rounded to one decimal),
  // so a true 89.96% can't slip past a 90% gate by rounding up to 90.0. Integer
  // math: covered/applicable < minPct/100  ⇔  covered*100 < applicable*minPct.
  if (m.covered * 100 < m.applicable * t.minPct) {
    return { ...base, pass: false, reason: 'below-threshold' };
  }
  return { ...base, pass: true, reason: 'ok' };
}

/**
 * Compare graph coverage against `RELOAD_COVERAGE_THRESHOLDS`, gating a metric
 * only when its producing stage actually ran (`ranStages`). Pure: takes a stats
 * snapshot, returns a structured pass/fail report — no I/O.
 */
export function evaluateCoverage(
  stats: StatsData,
  ranStages: ReadonlySet<ReloadStageName>,
): VerifyReport {
  const metrics: MetricVerdict[] = [];

  // Liveness floor: an empty graph makes every coverage metric trivially
  // "not-applicable" and would otherwise pass — the loudest silent zero of all.
  if (stats.counts.releases === 0) {
    metrics.push({
      metric: 'graphNotEmpty',
      stage: 'releases',
      covered: stats.counts.releases,
      applicable: 0,
      pct: null,
      threshold: 0,
      pass: false,
      reason: 'empty-graph',
    });
  }

  for (const t of RELOAD_COVERAGE_THRESHOLDS) {
    metrics.push(evaluateMetric(t, stats.enrichment[t.metric], ranStages));
  }

  const failing = metrics.filter((m) => !m.pass);
  return {
    pass: failing.length === 0,
    metrics,
    failingStages: [...new Set(failing.map((m) => m.stage))],
  };
}

/**
 * Flatten a report into a numeric counts map for persistence on the verify
 * ReloadStage node (its `countsJson` is numbers-only, surfaced verbatim by
 * `GET /admin/reload/status`). `_pass` is 1/0; `_pct` is omitted when null.
 */
export function reportToCounts(report: VerifyReport): Record<string, number> {
  const counts: Record<string, number> = {
    coverageChecksTotal: report.metrics.length,
    coverageChecksFailed: report.metrics.filter((m) => !m.pass).length,
  };
  for (const m of report.metrics) {
    counts[`${m.metric}_covered`] = m.covered;
    counts[`${m.metric}_applicable`] = m.applicable;
    counts[`${m.metric}_pass`] = m.pass ? 1 : 0;
    if (m.pct !== null) counts[`${m.metric}_pct`] = m.pct;
  }
  return counts;
}

/** Human-readable failure summary naming the offending stage(s) and metrics. */
export function formatVerifyFailure(report: VerifyReport): string {
  const failures = report.metrics.filter((m) => !m.pass);
  if (failures.length === 0) return 'verify gate passed';
  const stages = [...new Set(failures.map((m) => m.stage))].join(', ');
  const details = failures
    .map((m) => {
      const pct = m.pct === null ? 'n/a' : `${m.pct}%`;
      return `${m.stage}/${m.metric} ${m.reason} (covered ${m.covered}/${m.applicable}, ${pct}, floor ${m.threshold}%)`;
    })
    .join('; ');
  return `verify gate FAILED — ${failures.length} check(s) below bar in stage(s) [${stages}]: ${details}`;
}
