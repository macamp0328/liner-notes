#!/usr/bin/env tsx
// Self-healing writer: find merged PRs the fast path missed (or only got a
// PR-title fallback for) and (re)summarise them. Driven weekly by
// changelog-reconcile.yml (and manually via workflow_dispatch). The fast path
// (update.ts) can fail — a transient error, an unset secret on the day — and this
// reconverges the changelog to correct. This is the release-world analog of the
// repo's fail-on-drift guards (diagrams.yml / insomnia.yml): the store is
// derived, so it can always be rebuilt from the source of truth (the merged PRs).
//
// Within the window it summarises: PRs missing from the store, plus existing
// fallback entries once a key is available (so an entry written title-only while
// the key was down gets upgraded on the next run). `--refresh` re-does every entry.
//
// Usage: pnpm changelog:reconcile [--since YYYY-MM-DD] [--refresh]
//        DRY_RUN=1 prints the rebuilt body instead of writing.

import './env.js';
import { hasApiKey, summarize } from './claude.js';
import { getPrInput, listMergedPrNumbers, readStore, writeStore } from './store.js';
import { type ChangelogRecord, needsSummary, recordsByNumber, render, upsert } from './lib.js';

function isDryRun(): boolean {
  const v = process.env['DRY_RUN'];
  return v === '1' || v === 'true';
}

function sinceArg(): string {
  const i = process.argv.indexOf('--since');
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1]);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 21);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const since = sinceArg();
  const refresh = process.argv.includes('--refresh');
  const key = hasApiKey();

  const candidates = listMergedPrNumbers(since);
  const store = readStore();
  const have = recordsByNumber(store);
  const todo = candidates
    .map((c) => c.number)
    .filter((n) => needsSummary(have.get(n), { refresh, hasKey: key }));

  console.log(
    `Reconciling since ${since}: ${candidates.length} merged PRs, ${store.length} recorded, ${todo.length} to (re)summarise.`,
  );
  if (todo.length === 0) {
    console.log('Changelog is up to date — nothing to heal.');
    return;
  }
  console.log(`Working: ${todo.map((n) => `#${n}`).join(', ')}`);

  let records: ChangelogRecord[] = store;
  for (const number of todo) {
    const { record, note } = await summarize(getPrInput(number));
    records = upsert(records, record);
    console.log(`  #${number}: ${record.summary}  (${note})`);
  }

  if (isDryRun()) {
    console.log('\n--- DRY RUN: rebuilt body ---\n');
    console.log(render(records));
    return;
  }

  writeStore(records);
  console.log(
    `\nHealed ${todo.length} entr${todo.length === 1 ? 'y' : 'ies'} (${records.length} total).`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
