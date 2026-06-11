#!/usr/bin/env tsx
// Fast-path writer: summarise ONE merged PR and fold it into the changelog.
// Driven by the changelog.yml workflow on every push to main (PR_NUMBER set from
// the squash-merge commit). Run it by hand as `pnpm changelog:update <number>`
// (or PR_NUMBER=<number> pnpm changelog:update). Idempotent — re-running for the
// same PR replaces its record, so it doubles as a single-entry refresh. DRY_RUN=1
// prints the result without touching GitHub.

import './env.js';
import { appendFileSync } from 'node:fs';
import { summarize } from './claude.js';
import { getPrInput, readStore, writeStore } from './store.js';
import { type ChangelogRecord, render, resolvePrNumber, upsert } from './lib.js';

function isDryRun(): boolean {
  const v = process.env['DRY_RUN'];
  return v === '1' || v === 'true';
}

function previewLine(r: ChangelogRecord): string {
  const flag = r.breaking ? '⚠️ ' : '';
  return `${flag}[${r.category}] ${r.summary} (#${r.number}, @${r.author})`;
}

function writeStepSummary(r: ChangelogRecord, note: string): void {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (!file) return;
  const md = [
    '### Changelog updated',
    '',
    `**${previewLine(r)}**`,
    '',
    `- impact: \`${r.impact}\` · source: \`${r.summarySource}\``,
    `- ${note}`,
    '',
  ].join('\n');
  appendFileSync(file, `${md}\n`);
}

async function main(): Promise<void> {
  // PR number from the PR_NUMBER env (CI) or the first CLI arg (manual run).
  const number = resolvePrNumber(process.env['PR_NUMBER'], process.argv[2]);
  if (number === null) {
    const got = process.env['PR_NUMBER']?.trim() || process.argv[2]?.trim() || '';
    throw new Error(
      `Need a PR number. Run "pnpm changelog:update <number>" or set PR_NUMBER=<number> (got "${got}").`,
    );
  }

  const pr = getPrInput(number);
  const { record, note } = await summarize(pr);
  const records = upsert(readStore(), record);

  console.log(previewLine(record));
  console.log(note);
  writeStepSummary(record, note);

  if (isDryRun()) {
    console.log('\n--- DRY RUN: record ---');
    console.log(JSON.stringify(record, null, 2));
    console.log('\n--- DRY RUN: rendered body ---\n');
    console.log(render(records));
    return;
  }

  writeStore(records);
  console.log(`\nUpdated the "unreleased" draft release (${records.length} entries).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
