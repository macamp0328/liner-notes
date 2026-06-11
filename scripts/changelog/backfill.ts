#!/usr/bin/env tsx
// One-shot historical seed: summarise EVERY merged PR not already in the store,
// in a single Message Batch (50% cheaper, non-latency-sensitive). Run once after
// setup so the project ships with a complete, readable history instead of an
// empty log; thereafter the hook + reconciler keep it current.
//
// Idempotent and resumable: PRs already in the store are skipped, so re-running
// only fills what's missing. DRY_RUN=1 prints the rebuilt body without writing.

import { summarizeBatch } from './claude.js';
import { getPrInput, listAllMergedPrNumbers, readStore, writeStore } from './store.js';
import { type ChangelogRecord, render, upsert } from './lib.js';

function isDryRun(): boolean {
  const v = process.env['DRY_RUN'];
  return v === '1' || v === 'true';
}

async function main(): Promise<void> {
  const all = listAllMergedPrNumbers();
  const store = readStore();
  const have = new Set(store.map((r) => r.number));
  const targets = all.filter((n) => !have.has(n));

  console.log(
    `${all.length} merged PRs, ${store.length} already recorded, ${targets.length} to summarise.`,
  );
  if (targets.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  console.log('Fetching PR details…');
  const inputs = targets.map((number, i) => {
    if ((i + 1) % 25 === 0) console.log(`  fetched ${i + 1}/${targets.length}`);
    return getPrInput(number);
  });

  const newRecords = await summarizeBatch(inputs);
  let records: ChangelogRecord[] = store;
  for (const r of newRecords) records = upsert(records, r);

  if (isDryRun()) {
    console.log('\n--- DRY RUN: rebuilt body ---\n');
    console.log(render(records));
    return;
  }

  writeStore(records);
  console.log(`\nSeeded ${newRecords.length} entries (${records.length} total).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
