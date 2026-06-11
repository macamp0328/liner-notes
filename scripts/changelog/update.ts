#!/usr/bin/env tsx
// Fast-path writer: summarise ONE merged PR and fold it into the changelog.
// Driven by the changelog.yml workflow on every push to main (PR_NUMBER set from
// the squash-merge commit). Idempotent — re-running for the same PR replaces its
// record, never duplicates. DRY_RUN=1 prints the result without touching GitHub.

import { appendFileSync } from 'node:fs';
import { summarize } from './claude.js';
import { getPrInput, readStore, writeStore } from './store.js';
import { type ChangelogRecord, render, upsert } from './lib.js';

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
  const number = Number(process.env['PR_NUMBER']);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `PR_NUMBER must be a positive integer (got "${process.env['PR_NUMBER'] ?? ''}")`,
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
