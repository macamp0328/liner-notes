import { describe, it, expect } from 'vitest';
import {
  evaluateCoverage,
  reportToCounts,
  formatVerifyFailure,
  RELOAD_COVERAGE_THRESHOLDS,
} from '../../../src/ingestion/reload-verify.js';
import type { VerifyReport } from '../../../src/ingestion/reload-verify.js';
import type {
  CoverageMetric,
  SourcedCoverageMetric,
  StatsData,
} from '../../../src/db/stats-repository.js';
import type { ReloadStageName } from '../../../src/ingestion/stages.js';

// Mirror stats-repository's rounding: one decimal, null when nothing applies.
function cov(covered: number, applicable: number): CoverageMetric {
  return {
    covered,
    applicable,
    pct: applicable === 0 ? null : Math.round((covered / applicable) * 1000) / 10,
  };
}
function sourcedCov(covered: number, applicable: number): SourcedCoverageMetric {
  return { ...cov(covered, applicable), sources: {} };
}

const ALL_STAGES: ReloadStageName[] = [
  'releases',
  'lyrics',
  'master-data',
  'artist-genres',
  'artist-profiles',
  'group-members',
  'person-reconciliation',
  'mb-release-events',
  'track-musicbrainz',
  'track-works',
  'track-acousticbrainz',
  'track-deezer',
  'mb-artist-id',
  'nationality',
  'artist-wikidata',
  'artist-influences',
  'songwriter-reconciliation',
  'verify',
];
const ALL_RAN = new Set<ReloadStageName>(ALL_STAGES);

// A graph that clears every bar. Override one metric per test to flip a verdict.
function makeStats(
  overrides: { releases?: number; enrichment?: Partial<StatsData['enrichment']> } = {},
): StatsData {
  const enrichment: StatsData['enrichment'] = {
    releasesWithOriginalYear: cov(95, 100),
    artistsWithProfile: cov(85, 100),
    artistsWithGenres: cov(90, 100),
    artistsWithStyles: cov(90, 100),
    // #341/#393: the Wikidata metrics are ungated (surfaced in /stats only, like nationality).
    artistsWithWikidataId: cov(40, 100),
    artistsWithBirthDate: cov(35, 100),
    artistsWithImage: cov(10, 100),
    artistsWithAwards: cov(5, 100),
    artistsWithInstruments: cov(8, 100),
    artistsWithNationality: sourcedCov(50, 100),
    musiciansWithNationality: sourcedCov(50, 100),
    producersWithNationality: sourcedCov(50, 100),
    engineersWithNationality: sourcedCov(50, 100),
    tracksWithLyrics: sourcedCov(80, 100),
    lyricsFunnel: {
      resolved: 80,
      instrumental: 0,
      probableInstrumental: 0,
      lowConfidence: 0,
      notFound: 20,
      total: 100,
    },
    tracksWithRecordingMbid: cov(60, 100),
    tracksWithWork: cov(40, 60),
    // #335: clears the minPct:0 (silently-zero) bar — covered>0 over recordingMbid-bearing tracks.
    tracksWithMbRecordingArtists: cov(35, 60),
    // #339: production subset, measured but ungated (not in RELOAD_COVERAGE_THRESHOLDS).
    tracksWithMbProductionCredits: cov(18, 60),
    worksWithMultipleRecordings: 8,
    // #380: clears the minPct:0 (silently-zero) bar — covered>0 over writer-bearing Works.
    worksWithWriterLinks: cov(25, 40),
    wroteEdges: 30,
    tracksWithIsrc: cov(45, 100),
    tracksWithTempo: cov(30, 60),
    tracksWithDeezerBpm: cov(20, 45),
    tracksWithDeezerGain: cov(20, 45),
    mastersWithReleaseEvents: cov(40, 50),
    // #330: clears the minPct:100 gate — covered == applicable (deterministic exhaustive pass).
    samePersonLinks: cov(80, 80),
    memberOfEdges: 12,
    groupsWithMembers: 4,
    // #391: ungated raw count (surfaced in /stats only, like memberOfEdges).
    influencedByEdges: 6,
  };
  return {
    counts: {
      releases: overrides.releases ?? 100,
      artists: 100,
      tracks: 100,
      masters: 50,
      musicians: 100,
      works: 50,
    },
    enrichment: { ...enrichment, ...overrides.enrichment },
  };
}

function verdict(report: VerifyReport, metric: string) {
  const v = report.metrics.find((m) => m.metric === metric);
  if (!v) throw new Error(`no verdict for ${metric}`);
  return v;
}

describe('RELOAD_COVERAGE_THRESHOLDS', () => {
  it('pins the operator-confirmed bars, once', () => {
    const byMetric = Object.fromEntries(RELOAD_COVERAGE_THRESHOLDS.map((t) => [t.metric, t]));
    expect(byMetric['releasesWithOriginalYear']?.minPct).toBe(90);
    expect(byMetric['artistsWithProfile']?.minPct).toBe(80);
    expect(byMetric['tracksWithRecordingMbid']?.minPct).toBe(50);
    expect(byMetric['tracksWithIsrc']?.minPct).toBe(40);
    // best-effort sources gated for "populated" only
    expect(byMetric['tracksWithLyrics']?.minPct).toBe(0);
    expect(byMetric['tracksWithTempo']?.minPct).toBe(0);
    expect(byMetric['tracksWithDeezerBpm']?.minPct).toBe(0);
    // #380: WROTE coverage is best-effort → silently-zero protection only.
    expect(byMetric['worksWithWriterLinks']?.minPct).toBe(0);
  });

  it('does NOT gate tracksWithMbProductionCredits — it can legitimately be near-zero (#339)', () => {
    const metrics = RELOAD_COVERAGE_THRESHOLDS.map((t) => t.metric);
    expect(metrics).not.toContain('tracksWithMbProductionCredits');
  });

  it('maps each metric to the stage that produces it', () => {
    const byMetric = Object.fromEntries(RELOAD_COVERAGE_THRESHOLDS.map((t) => [t.metric, t.stage]));
    expect(byMetric['releasesWithOriginalYear']).toBe('master-data');
    expect(byMetric['tracksWithRecordingMbid']).toBe('track-musicbrainz');
    expect(byMetric['tracksWithIsrc']).toBe('track-musicbrainz');
    expect(byMetric['tracksWithTempo']).toBe('track-acousticbrainz');
    expect(byMetric['worksWithWriterLinks']).toBe('songwriter-reconciliation');
  });
});

describe('evaluateCoverage — verdict matrix', () => {
  it('passes a fully-enriched graph with every stage run', () => {
    const report = evaluateCoverage(makeStats(), ALL_RAN);
    expect(report.pass).toBe(true);
    expect(report.failingStages).toEqual([]);
    expect(verdict(report, 'releasesWithOriginalYear').reason).toBe('ok');
  });

  it('fails a metric below its floor (below-threshold), naming the stage', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { releasesWithOriginalYear: cov(80, 100) } }),
      ALL_RAN,
    );
    expect(report.pass).toBe(false);
    expect(verdict(report, 'releasesWithOriginalYear')).toMatchObject({
      pass: false,
      reason: 'below-threshold',
      stage: 'master-data',
    });
    expect(report.failingStages).toContain('master-data');
  });

  it('passes pct exactly equal to the floor (inclusive)', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { releasesWithOriginalYear: cov(90, 100) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'releasesWithOriginalYear')).toMatchObject({ pass: true, reason: 'ok' });
  });

  it('gates on exact counts, not the rounded pct, at the floor boundary', () => {
    // 8996/10000 = 89.96% rounds to 90.0 in getStats, but is below a 90% floor.
    const metric = cov(8996, 10000);
    expect(metric.pct).toBe(90); // confirms the rounding that the exact check defeats
    const report = evaluateCoverage(
      makeStats({ enrichment: { releasesWithOriginalYear: metric } }),
      ALL_RAN,
    );
    expect(verdict(report, 'releasesWithOriginalYear')).toMatchObject({
      pass: false,
      reason: 'below-threshold',
    });
  });

  it('treats applicable=0 as not-applicable (not a failure) even with 0 covered', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { releasesWithOriginalYear: cov(0, 0) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'releasesWithOriginalYear')).toMatchObject({
      pass: true,
      reason: 'not-applicable',
    });
    expect(report.pass).toBe(true);
  });

  it('fails silently-zero: stage ran, real candidates, produced nothing (the #151 bug)', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { tracksWithRecordingMbid: cov(0, 100) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'tracksWithRecordingMbid')).toMatchObject({
      pass: false,
      reason: 'silently-zero',
      stage: 'track-musicbrainz',
    });
    expect(report.failingStages).toContain('track-musicbrainz');
  });

  it('fails silently-zero even for a minPct=0 metric (lyrics) when it ran', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { tracksWithLyrics: sourcedCov(0, 100) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'tracksWithLyrics')).toMatchObject({
      pass: false,
      reason: 'silently-zero',
    });
  });

  it('fails worksWithWriterLinks silently-zero (broken WROTE chain) when reconciliation ran (#380)', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { worksWithWriterLinks: cov(0, 40) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'worksWithWriterLinks')).toMatchObject({
      pass: false,
      reason: 'silently-zero',
      stage: 'songwriter-reconciliation',
    });
  });

  it('exempts worksWithWriterLinks when songwriter-reconciliation did not run (#380)', () => {
    const ran = new Set(ALL_RAN);
    ran.delete('songwriter-reconciliation');
    const report = evaluateCoverage(
      makeStats({ enrichment: { worksWithWriterLinks: cov(0, 40) } }),
      ran,
    );
    expect(verdict(report, 'worksWithWriterLinks')).toMatchObject({
      pass: true,
      reason: 'not-run',
    });
  });

  it('exempts a metric whose stage did not run this job (not-run)', () => {
    const ran = new Set(ALL_RAN);
    ran.delete('track-musicbrainz'); // e.g. no MusicBrainz client configured
    const report = evaluateCoverage(
      makeStats({ enrichment: { tracksWithRecordingMbid: cov(0, 100) } }),
      ran,
    );
    expect(verdict(report, 'tracksWithRecordingMbid')).toMatchObject({
      pass: true,
      reason: 'not-run',
    });
    expect(report.pass).toBe(true);
  });

  // #330: the samePersonLinks gate is minPct:100 — meaningful only because reconciliation is
  // deterministic + exhaustive (covered == applicable after a good run). A 0 floor would be
  // decorative since inline mergeSamePersonAs already guarantees covered>0.
  it('fails samePersonLinks below 100% when person-reconciliation ran (broken/partial pass)', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { samePersonLinks: cov(79, 80) } }),
      ALL_RAN,
    );
    expect(report.pass).toBe(false);
    expect(verdict(report, 'samePersonLinks')).toMatchObject({
      pass: false,
      reason: 'below-threshold',
      stage: 'person-reconciliation',
    });
    expect(report.failingStages).toContain('person-reconciliation');
  });

  it('passes samePersonLinks when covered == applicable (100%)', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { samePersonLinks: cov(50, 50) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'samePersonLinks')).toMatchObject({ pass: true, reason: 'ok' });
  });

  it('exempts samePersonLinks as not-applicable when no Musician matches an Artist', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { samePersonLinks: cov(0, 0) } }),
      ALL_RAN,
    );
    expect(verdict(report, 'samePersonLinks')).toMatchObject({
      pass: true,
      reason: 'not-applicable',
    });
  });

  it('exempts samePersonLinks when person-reconciliation did not run', () => {
    const ran = new Set(ALL_RAN);
    ran.delete('person-reconciliation');
    const report = evaluateCoverage(
      makeStats({ enrichment: { samePersonLinks: cov(0, 80) } }),
      ran,
    );
    expect(verdict(report, 'samePersonLinks')).toMatchObject({ pass: true, reason: 'not-run' });
  });

  it('fails an empty graph loudly (liveness floor)', () => {
    const report = evaluateCoverage(makeStats({ releases: 0 }), ALL_RAN);
    expect(report.pass).toBe(false);
    expect(verdict(report, 'graphNotEmpty')).toMatchObject({ pass: false, reason: 'empty-graph' });
    expect(report.failingStages).toContain('releases');
  });

  it('reports every distinct failing stage once', () => {
    const report = evaluateCoverage(
      makeStats({
        enrichment: {
          releasesWithOriginalYear: cov(10, 100),
          tracksWithRecordingMbid: cov(0, 100),
          tracksWithIsrc: cov(0, 100), // also track-musicbrainz
        },
      }),
      ALL_RAN,
    );
    expect(report.failingStages.sort()).toEqual(['master-data', 'track-musicbrainz']);
  });
});

describe('reportToCounts', () => {
  it('flattens a passing report into numeric counts (pct omitted when null)', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { releasesWithOriginalYear: cov(0, 0) } }),
      ALL_RAN,
    );
    const counts = reportToCounts(report);
    expect(counts['coverageChecksFailed']).toBe(0);
    expect(counts['coverageChecksTotal']).toBe(RELOAD_COVERAGE_THRESHOLDS.length);
    expect(counts['releasesWithOriginalYear_covered']).toBe(0);
    expect(counts['releasesWithOriginalYear_applicable']).toBe(0);
    expect(counts['releasesWithOriginalYear_pass']).toBe(1);
    // pct is null for applicable=0 → key omitted
    expect(counts['releasesWithOriginalYear_pct']).toBeUndefined();
    // a metric with a real pct keeps it
    expect(counts['artistsWithProfile_pct']).toBe(85);
  });

  it('counts the failures', () => {
    const report = evaluateCoverage(
      makeStats({ enrichment: { tracksWithRecordingMbid: cov(0, 100) } }),
      ALL_RAN,
    );
    const counts = reportToCounts(report);
    expect(counts['coverageChecksFailed']).toBe(1);
    expect(counts['tracksWithRecordingMbid_pass']).toBe(0);
  });
});

describe('formatVerifyFailure', () => {
  it('returns a passed message when nothing failed', () => {
    const report = evaluateCoverage(makeStats(), ALL_RAN);
    expect(formatVerifyFailure(report)).toBe('verify gate passed');
  });

  it('names the offending stage(s) and metrics, handling null pct', () => {
    const report = evaluateCoverage(
      makeStats({ releases: 0, enrichment: { artistsWithProfile: cov(10, 100) } }),
      ALL_RAN,
    );
    const msg = formatVerifyFailure(report);
    expect(msg).toContain('verify gate FAILED');
    expect(msg).toContain('artist-profiles');
    expect(msg).toContain('releases'); // empty-graph verdict
    expect(msg).toContain('n/a'); // empty-graph verdict has null pct
  });
});
