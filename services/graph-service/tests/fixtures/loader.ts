import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { mergeReleaseGraph } from '../../src/db/ingestion-repository.js';
import type { DiscogsRelease } from '../../src/ingestion/types.js';

const releasesDir = join(dirname(fileURLToPath(import.meta.url)), 'releases');

/** All seed releases, ordered deterministically by filename. */
function loadReleases(): DiscogsRelease[] {
  return readdirSync(releasesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(releasesDir, name), 'utf8')) as DiscogsRelease);
}

/**
 * Seed the graph by running the real ingestion transforms + MERGE writes
 * over every fixture in tests/fixtures/releases/. This exercises the same
 * code path as production ingestion — only the Discogs HTTP fetch is replaced
 * by static JSON.
 */
export async function seedGraph(driver: Driver): Promise<void> {
  for (const release of loadReleases()) {
    await mergeReleaseGraph(driver, release);
  }
}

/** Fully wipe the graph so each integration test file starts from empty. */
export async function clearGraph(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run('MATCH (n) DETACH DELETE n');
  } finally {
    await session.close();
  }
}
