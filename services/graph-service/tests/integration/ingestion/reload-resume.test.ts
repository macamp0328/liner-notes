import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { initTestDriver } from '../setup.js';
import { clearGraph } from '../../fixtures/loader.js';
import { mergeReleaseGraph } from '../../../src/db/ingestion-repository.js';
import { runReload } from '../../../src/ingestion/orchestrator.js';
import { RELOAD_STAGES } from '../../../src/ingestion/stages.js';
import {
  createReloadJob,
  markStageComplete,
  markStageRunning,
  getReloadJob,
} from '../../../src/db/job-repository.js';
import type { DiscogsRelease } from '../../../src/ingestion/types.js';
import release7000001 from '../../fixtures/releases/release-7000001.json' with { type: 'json' };

const RELEASE_ID = 7000001;

// The crash point: stages before this were "already done" (complete); this one was mid-flight
// when the pod died (left `running`); everything after is `pending`. track-musicbrainz is chosen
// deliberately: its track-acousticbrainz/track-deezer dependents must resume after it re-runs and
// settles as `skipped` (musicbrainz client unset) — exercising "a dep is satisfied by ANY terminal
// state", not just `complete`.
const CRASH_STAGE = 'track-musicbrainz';
const STAGE_NAMES = RELOAD_STAGES.map((s) => s.name);
const DONE_BEFORE_CRASH: string[] = STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(CRASH_STAGE));

// Stages whose run() returns null (→ `skipped`) because the musicbrainz client is unset (see
// beforeAll). One that actually runs settles `skipped`; one pre-marked complete stays `complete`.
const MUSICBRAINZ_STAGES = new Set(['track-musicbrainz', 'mb-release-events', 'nationality']);

function expectedStatus(name: string): 'complete' | 'skipped' {
  if (DONE_BEFORE_CRASH.includes(name)) return 'complete';
  return MUSICBRAINZ_STAGES.has(name) ? 'skipped' : 'complete';
}

// MUSICBRAINZ_USER_AGENT is included so beforeAll can deterministically unset it (its
// presence would make buildMusicBrainzClientFromEnv non-null, so the mb-release-events /
// track-musicbrainz / nationality stages would run instead of skip) and afterAll restores it.
const ENV_KEYS = [
  'DISCOGS_TOKEN',
  'DISCOGS_USERNAME',
  'DISCOGS_USER_AGENT',
  'MUSICBRAINZ_USER_AGENT',
] as const;

function make404Router(): Response {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue({ message: 'Not Found' }),
  } as unknown as Response;
}

async function countReleases(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const res = await session.run('MATCH (r:Release) RETURN count(r) AS n');
    return (res.records[0]?.get('n') as { toNumber(): number }).toNumber();
  } finally {
    await session.close();
  }
}

/**
 * Seed the enrichments the #178 verify gate checks for stages that ran/are-done this
 * job, so a healthy resume still ends `complete`. recordingMbid/isrc stay null →
 * track-musicbrainz is skipped (no MB client) → exempt; tempo/deezer applicable 0.
 */
async function seedVerifyPassingEnrichment(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (t:Track)
       SET t.lyrics = coalesce(t.lyrics, 'la la la'),
           t.lyricsSource = coalesce(t.lyricsSource, 'lrclib')`,
    );
    await session.run(`MATCH (r:Release) SET r.originalYear = coalesce(r.originalYear, 1965)`);
    await session.run(
      `MATCH (a:Artist) WHERE a.discogsId IS NOT NULL
       SET a.profile = coalesce(a.profile, 'seeded profile')`,
    );
  } finally {
    await session.close();
  }
}

describe('reload resume after a simulated crash (real Neo4j)', () => {
  let driver: Driver;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env['DISCOGS_TOKEN'] = 'test-token';
    process.env['DISCOGS_USERNAME'] = 'integration-test-user';
    process.env['DISCOGS_USER_AGENT'] = 'liner-notes/test';
    // Explicitly unset so the musicbrainz client is null and its stages (mb-release-events /
    // track-musicbrainz / nationality) resolve to `skipped` — deterministic regardless of
    // any MUSICBRAINZ_USER_AGENT the dev/CI environment happens to export.
    delete process.env['MUSICBRAINZ_USER_AGENT'];
    driver = initTestDriver();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await clearGraph(driver);
  });

  it('skips completed stages, resumes the rest, and never re-wipes the graph', async () => {
    // 1. A non-empty graph (the `releases` stage already ran before the crash).
    await clearGraph(driver);
    await mergeReleaseGraph(driver, release7000001 as unknown as DiscogsRelease);
    expect(await countReleases(driver)).toBe(1);
    await seedVerifyPassingEnrichment(driver);

    // 2. A persisted job mid-reload: everything up to the crash stage is complete, the
    //    crash stage is `running`, the rest are `pending` (as createReloadJob leaves them).
    const jobId = await createReloadJob(driver, STAGE_NAMES);
    for (const name of DONE_BEFORE_CRASH) {
      await markStageComplete(driver, jobId, name, { enriched: 0 });
    }
    await markStageRunning(driver, jobId, CRASH_STAGE);

    // 3. Any stage that does run hits a 404-everything fetch, so nothing touches the network.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(make404Router()));

    // 4. Resume the interrupted job.
    const result = await runReload(driver, {
      username: 'integration-test-user',
      resumeJobId: jobId,
    });

    // 5. The job finishes cleanly and the same jobId is continued (not a new one).
    expect(result.jobId).toBe(jobId);
    expect(result.status).toBe('complete');

    // 6. The graph was NOT re-wiped — the seeded release survives — and the `releases`
    //    stage was never re-run (its collection endpoint was never fetched).
    expect(await countReleases(driver)).toBe(1);
    const fetchedUrls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(fetchedUrls.some((u: string) => u.includes('/collection/folders/0/releases'))).toBe(
      false,
    );

    // 7. Every stage is terminal exactly once, derived from the schedule (not hard-coded
    //    positions): pre-done stages stay complete, the musicbrainz stages skip (client unset),
    //    the rest complete. Crucially track-acousticbrainz/track-deezer complete even though their
    //    track-musicbrainz dependency settled as `skipped`.
    const job = await getReloadJob(driver, jobId);
    expect(job).not.toBeNull();
    const byName = Object.fromEntries((job?.stages ?? []).map((s) => [s.stage, s.status]));

    for (const name of STAGE_NAMES) {
      expect(byName[name], `stage ${name}`).toBe(expectedStatus(name));
    }
    expect(byName['track-musicbrainz']).toBe('skipped');
    expect(byName['track-acousticbrainz']).toBe('complete');
    expect(byName['track-deezer']).toBe('complete');

    // No stage left pending or running.
    const statuses = (job?.stages ?? []).map((s) => s.status);
    expect(statuses).not.toContain('pending');
    expect(statuses).not.toContain('running');
  });
});
