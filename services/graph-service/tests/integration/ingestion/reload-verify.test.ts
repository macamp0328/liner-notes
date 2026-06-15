import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { initTestDriver } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { mergeReleaseGraph } from '../../../src/db/ingestion-repository.js';
import { runReload } from '../../../src/ingestion/orchestrator.js';
import { RELOAD_STAGES } from '../../../src/ingestion/stages.js';
import {
  createReloadJob,
  markStageComplete,
  getReloadJob,
} from '../../../src/db/job-repository.js';
import type { PersistedStage } from '../../../src/db/job-repository.js';
import type { DiscogsRelease } from '../../../src/ingestion/types.js';
import release7000001 from '../../fixtures/releases/release-7000001.json' with { type: 'json' };

const STAGE_NAMES = RELOAD_STAGES.map((s) => s.name);

/**
 * Seed coverage on the whole graph so every gated metric clears its bar. With
 * `originalYear: false`, the release keeps a masterDiscogsId (so originalYear is
 * applicable) but no originalYear — the exact silently-zero shape of #151.
 */
async function seedCoverage(driver: Driver, opts: { originalYear: boolean }): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release) SET r.masterDiscogsId = coalesce(r.masterDiscogsId, 800001)` +
        (opts.originalYear ? ', r.originalYear = 1965' : ''),
    );
    await session.run(
      `MATCH (t:Track)
       SET t.lyrics = 'la la la', t.lyricsSource = 'lrclib',
           t.recordingMbid = 'mbid-' + t.position,
           t.isrc = 'isrc-' + t.position,
           t.tempo = 120.0, t.deezerBpm = 120.0`,
    );
    // #336: link the recordingMbid tracks to a Work so tracksWithWork (gated silently-zero) clears.
    await session.run(
      `MATCH (t:Track) WHERE t.recordingMbid IS NOT NULL
       MERGE (w:Work {mbid: 'work-seed'})
       MERGE (t)-[rel:RECORDING_OF]->(w) SET rel.source = 'musicbrainz'`,
    );
    // #335: give the recordingMbid tracks an MB-sourced track credit so
    // tracksWithMbRecordingArtists (gated silently-zero) clears.
    await session.run(
      `MATCH (t:Track) WHERE t.recordingMbid IS NOT NULL
       MERGE (m:Musician {musicbrainzId: 'mb-seed-performer'})
         ON CREATE SET m.name = 'Seed Performer'
       MERGE (m)-[c:CREDITED_ON]->(t)
       SET c.scope = 'track', c.source = 'musicbrainz', c.role = 'guitar'`,
    );
    await session.run(`MATCH (a:Artist) WHERE a.discogsId IS NOT NULL SET a.profile = 'seeded'`);
  } finally {
    await session.close();
  }
}

/**
 * A job where every stage but `verify` is already complete, so resuming it runs
 * only the verify gate against the seeded graph (no enrichment stages, no network).
 */
async function runVerifyOnly(driver: Driver): Promise<string> {
  const jobId = await createReloadJob(driver, STAGE_NAMES);
  for (const name of STAGE_NAMES.filter((n) => n !== 'verify')) {
    await markStageComplete(driver, jobId, name, {});
  }
  await runReload(driver, { username: 'tester', resumeJobId: jobId });
  return jobId;
}

async function verifyStage(driver: Driver, jobId: string): Promise<PersistedStage> {
  const job = await getReloadJob(driver, jobId);
  const stage = job?.stages.find((s) => s.stage === 'verify');
  if (!stage) throw new Error('verify stage not found');
  return stage;
}

describe('reload verify gate (real Neo4j)', () => {
  let driver: Driver;

  beforeAll(() => {
    driver = initTestDriver();
  });

  afterAll(async () => {
    await clearGraph(driver);
  });

  it('fails the reload loud when a stage that ran is silently zero, naming the stage', async () => {
    await clearGraph(driver);
    await mergeReleaseGraph(driver, release7000001 as unknown as DiscogsRelease);
    await seedCoverage(driver, { originalYear: false });

    const jobId = await runVerifyOnly(driver);

    const job = await getReloadJob(driver, jobId);
    expect(job?.status).toBe('failed');

    const verify = await verifyStage(driver, jobId);
    expect(verify.status).toBe('failed');
    expect(verify.error).toContain('master-data');
    expect(verify.counts['coverageChecksFailed']).toBeGreaterThanOrEqual(1);
    expect(verify.counts['releasesWithOriginalYear_pass']).toBe(0);
  });

  it('completes when every gated metric clears its bar', async () => {
    await clearGraph(driver);
    await mergeReleaseGraph(driver, release7000001 as unknown as DiscogsRelease);
    await seedCoverage(driver, { originalYear: true });

    const jobId = await runVerifyOnly(driver);

    const job = await getReloadJob(driver, jobId);
    expect(job?.status).toBe('complete');

    const verify = await verifyStage(driver, jobId);
    expect(verify.status).toBe('complete');
    expect(verify.counts['coverageChecksFailed']).toBe(0);
    expect(verify.counts['releasesWithOriginalYear_pass']).toBe(1);
  });
});
