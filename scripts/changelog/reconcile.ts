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
import { currentModel, hasApiKey, summarize } from './claude.js';
import {
  getPrInput,
  listMergedPrNumbers,
  readStore,
  readVersions,
  writeDraft,
  writeVersionRelease,
} from './store.js';
import {
  type ChangelogRecord,
  type VersionRecord,
  backfillVersionStamps,
  computeStats,
  needsSummary,
  preserveVersion,
  previousVersion,
  recordsByNumber,
  releaseTitle,
  renderBaseline,
  renderUnreleased,
  renderVersion,
  upsert,
} from './lib.js';

function isDryRun(): boolean {
  const v = process.env['DRY_RUN'];
  return v === '1' || v === 'true';
}

/**
 * Re-render EVERY published release from the store + versions.json — deterministic,
 * NO new AI calls (headline/narrative/tier are frozen in the VersionRecord at cut
 * time). This is what self-heals a hand-edited or drifted release body weekly, and
 * the release-world analog of the repo's fail-on-drift guards. Reconcile never cuts
 * a NEW version — that's release.ts's job alone.
 */
function rerenderPublishedReleases(
  records: readonly ChangelogRecord[],
  versions: readonly VersionRecord[],
  dryRun: boolean,
): void {
  const byNumber = recordsByNumber(records);
  for (const v of versions) {
    const slice = v.prNumbers.map((n) => byNumber.get(n)).filter((r): r is ChangelogRecord => !!r);
    const body =
      v.tier === 'baseline'
        ? renderBaseline(slice, { model: v.model })
        : renderVersion(v, slice, computeStats(v, previousVersion(versions, v.tag)), {
            model: v.model,
          });
    const title = releaseTitle(v.tag, v.headline);
    if (dryRun) {
      console.log(`\n--- DRY RUN: ${title} ---\n`);
      console.log(body);
      continue;
    }
    writeVersionRelease(v.tag, v.targetSha, title, body);
    console.log(`  re-rendered ${v.tag}`);
  }
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
  const versions = readVersions();
  const have = recordsByNumber(store);
  const todo = candidates
    .map((c) => c.number)
    .filter((n) => needsSummary(have.get(n), { refresh, hasKey: key }));

  console.log(
    `Reconciling since ${since}: ${candidates.length} merged PRs, ${store.length} recorded, ` +
      `${todo.length} to (re)summarise; ${versions.length} published version(s).`,
  );
  if (todo.length > 0) console.log(`Working: ${todo.map((n) => `#${n}`).join(', ')}`);

  let records: ChangelogRecord[] = store;
  for (const number of todo) {
    const { record, note } = await summarize(getPrInput(number));
    // Carry forward an existing version stamp so a heal never un-releases a PR.
    records = upsert(records, preserveVersion(record, have.get(number)));
    console.log(`  #${number}: ${record.summary}  (${note})`);
  }

  // Version back-fill heal, then re-render every published release + the draft from
  // the (records, versions) pair. No AI — frozen metadata makes this deterministic,
  // so an unchanged store re-renders byte-identical bodies (the weekly self-heal).
  records = backfillVersionStamps(records, versions);

  if (isDryRun()) {
    console.log('\n--- DRY RUN: rebuilt unreleased body ---\n');
    console.log(renderUnreleased(records, { model: currentModel() }));
    rerenderPublishedReleases(records, versions, true);
    return;
  }

  rerenderPublishedReleases(records, versions, false);
  writeDraft(records, versions, { model: currentModel() });
  console.log(
    `\nHealed ${todo.length} entr${todo.length === 1 ? 'y' : 'ies'}; ` +
      `re-rendered ${versions.length} version(s) (${records.length} records total).`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
