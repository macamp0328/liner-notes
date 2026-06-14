#!/usr/bin/env tsx
// One-shot historical seed: summarise merged PRs into the store in a single
// Message Batch (50% cheaper, non-latency-sensitive). Run once after setup so the
// project ships with a complete history instead of an empty log; thereafter the
// hook + reconciler keep it current.
//
// What it summarises (idempotent / resumable):
//   - PRs not yet in the store — always;
//   - existing PR-title *fallback* entries — upgraded to Claude summaries, but
//     only when ANTHROPIC_API_KEY is set (so a keyless run never churns);
//   - with `--refresh`: re-summarise EVERY entry (e.g. after editing style.md).
//
// DRY_RUN=1 prints the rebuilt body without writing.

import './env.js';
import { disclosureModel, hasApiKey, summarizeBatch } from './claude.js';
import {
  getPrInput,
  listAllMergedPrNumbers,
  readStoreTolerant,
  readVersions,
  writeDraft,
} from './store.js';
import {
  type ChangelogRecord,
  needsSummary,
  preserveVersion,
  recordsByNumber,
  renderUnreleased,
  upsert,
} from './lib.js';

function isDryRun(): boolean {
  const v = process.env['DRY_RUN'];
  return v === '1' || v === 'true';
}

async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');
  const key = hasApiKey();

  const all = listAllMergedPrNumbers();
  // Tolerant read: backfill rebuilds the store from source, so a persisted corrupt
  // line is dropped and re-summarised rather than wedging the seed/repair path.
  const store = readStoreTolerant();
  const versions = readVersions();
  const have = recordsByNumber(store);
  const targets = all.filter((n) => needsSummary(have.get(n), { refresh, hasKey: key }));

  const fresh = targets.filter((n) => !have.has(n)).length;
  const upgrades = targets.length - fresh;
  console.log(
    `${all.length} merged PRs, ${store.length} recorded → ${fresh} new + ${upgrades} to re-summarise = ${targets.length} target(s).`,
  );
  if (!key) {
    console.log(
      'No ANTHROPIC_API_KEY — new PRs get the PR-title fallback; existing entries left as-is.',
    );
  } else if (refresh) {
    console.log('--refresh: re-summarising every entry with Claude.');
  }
  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('Fetching PR details…');
  const inputs = targets.map((number, i) => {
    if ((i + 1) % 25 === 0) console.log(`  fetched ${i + 1}/${targets.length}`);
    return getPrInput(number);
  });

  const summarised = await summarizeBatch(inputs);
  let records: ChangelogRecord[] = store;
  // Carry forward existing version stamps so re-summarising never un-releases a PR.
  for (const r of summarised) records = upsert(records, preserveVersion(r, have.get(r.number)));

  if (isDryRun()) {
    console.log('\n--- DRY RUN: rebuilt unreleased body ---\n');
    console.log(renderUnreleased(records, { model: disclosureModel() }));
    return;
  }

  writeDraft(records, versions, { model: disclosureModel() });
  console.log(
    `\nWrote ${summarised.length} entr${summarised.length === 1 ? 'y' : 'ies'} (${records.length} total).`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
