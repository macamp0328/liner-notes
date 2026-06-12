#!/usr/bin/env tsx
// Cut a PUBLISHED, tagged CalVer release from everything currently Unreleased.
// Driven by changelog-release.yml on a successful production deploy (HEAD_SHA =
// the deployed commit). A version means "this is what's live": it sweeps every
// record with `version === null`, assigns a `vYYYY.MM.DD` tag, writes a real
// (non-draft) GitHub Release whose richness ramps with the release's importance
// tier, then stamps those records and records the version in versions.json.
//
//   pnpm changelog:release              # cut a version (needs HEAD_SHA)
//   pnpm changelog:baseline             # one-shot: publish the v0.1.0 history baseline
//   DRY_RUN=1 …                         # preview, no GitHub writes, no AI heal
//   RELEASE_DATE=2026-06-11 …           # override the cut date (tests)
//
// Self-healing of published bodies lives in reconcile.ts; this script only ever
// CUTS new versions.

import './env.js';
import { appendFileSync } from 'node:fs';
import {
  currentModel,
  fallbackVersionNarrative,
  hasApiKey,
  summarize,
  summarizeVersion,
} from './claude.js';
import {
  defaultBranchSha,
  getPrInput,
  listMergedPrNumbers,
  listReleaseTags,
  readStore,
  readVersions,
  writeDraft,
  writeVersionRelease,
} from './store.js';
import {
  type ChangelogRecord,
  type VersionNarrative,
  type VersionRecord,
  buildCut,
  calverTag,
  computeTier,
  needsSummary,
  preserveVersion,
  previousVersion,
  recordsByNumber,
  releaseTitle,
  renderBaseline,
  stampVersion,
  unreleasedRecords,
  upsert,
} from './lib.js';

const BASELINE_TAG = 'v0.1.0';
const BASELINE_HEADLINE = 'Initial history';
const HEAL_WINDOW_DAYS = 3;

function isDryRun(): boolean {
  const v = process.env['DRY_RUN'];
  return v === '1' || v === 'true';
}

/** The cut date — `RELEASE_DATE` override (tests) or now. (A real tsx script may use Date.) */
function resolveReleaseDate(): Date {
  const raw = process.env['RELEASE_DATE']?.trim();
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** gh's "tag already exists" error — the trigger to recompute the same-day `.N` suffix. */
function isAlreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

function writeStepSummary(lines: string[]): void {
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (!file) return;
  appendFileSync(file, `${lines.join('\n')}\n`);
}

// ── The cut ───────────────────────────────────────────────────────────────────

async function runCut(): Promise<void> {
  const headSha = process.env['HEAD_SHA']?.trim();
  if (!headSha) {
    throw new Error(
      'HEAD_SHA is required (the deployed commit). Set it from workflow_run.head_sha.',
    );
  }
  const dryRun = isDryRun();
  const key = hasApiKey();
  const releaseDate = resolveReleaseDate();

  let records = readStore();
  const versions = readVersions();

  // Ensure the deploy's merged PRs are summarised before we cut — covers the race
  // where changelog.yml hasn't folded in the triggering merge yet. Skipped on a
  // dry run (avoids API/gh side effects); the live path always heals.
  if (dryRun) {
    console.log('(dry-run: skipping the heal-window summarise)');
  } else {
    records = await healRecentPrs(records, releaseDate, key);
  }

  const unreleased = unreleasedRecords(records);
  if (unreleased.length === 0) {
    console.log('No pending changes since the last version — nothing to cut.');
    return;
  }

  const existingTags = new Set([...listReleaseTags(), ...versions.map((v) => v.tag)]);
  let tag = calverTag(releaseDate, [...existingTags]);
  const tier = computeTier(unreleased);
  const prevTag = previousVersion(versions, tag)?.tag ?? null;

  // Maintenance (and no-key) skip the version-level AI call entirely.
  const vn: VersionNarrative =
    tier === 'maintenance'
      ? fallbackVersionNarrative(unreleased.length)
      : await summarizeVersion({ tag, tier, records: unreleased, prevTag });

  let cut = buildCut(tag, tier, vn, unreleased, releaseDate, headSha, versions);

  console.log(
    `Tag: ${tag}  ·  tier: ${tier}  ·  ${unreleased.length} PR(s)  ·  prev: ${prevTag ?? '(none)'}`,
  );
  console.log(`Title: ${cut.title}`);
  if (vn.narrative) console.log(`Narrative: ${vn.narrative}`);

  if (dryRun) {
    console.log('\n--- DRY RUN: version release body ---\n');
    console.log(cut.body);
    console.log(`\n--- DRY RUN: would stamp PRs ${cut.versionRecord.prNumbers.join(', ')} ---`);
    return;
  }

  // Publish FIRST, then stamp + rewrite the draft. A crash between is healed by the
  // reconciler's version back-fill. On a same-day tag collision, recompute `.N`
  // against the now-visible tag and retry once.
  try {
    writeVersionRelease(tag, headSha, cut.title, cut.body);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    tag = calverTag(releaseDate, [...listReleaseTags(), tag]);
    console.log(`Tag collision — retrying as ${tag}.`);
    cut = buildCut(tag, tier, vn, unreleased, releaseDate, headSha, versions);
    writeVersionRelease(tag, headSha, cut.title, cut.body);
  }

  const stamped = stampVersion(records, cut.versionRecord.prNumbers, tag);
  writeDraft(stamped, [...versions, cut.versionRecord], { model: currentModel() });

  console.log(`\nPublished ${cut.title} (${cut.versionRecord.prNumbers.length} PRs).`);
  writeStepSummary([
    `### Cut ${cut.title}`,
    '',
    `- tier: \`${tier}\` · ${cut.versionRecord.prNumbers.length} PR(s) · since ${prevTag ?? '(first)'}`,
    vn.narrative ? `- ${vn.narrative}` : `- (no narrative — ${tier} tier)`,
    '',
  ]);
}

/** Summarise any PRs merged in the last `HEAL_WINDOW_DAYS` that aren't recorded yet. */
async function healRecentPrs(
  records: ChangelogRecord[],
  releaseDate: Date,
  key: boolean,
): Promise<ChangelogRecord[]> {
  const since = new Date(releaseDate.getTime() - HEAL_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const have = recordsByNumber(records);
  const todo = listMergedPrNumbers(since)
    .map((c) => c.number)
    .filter((n) => needsSummary(have.get(n), { refresh: false, hasKey: key }));
  if (todo.length === 0) return records;
  console.log(`Heal window (since ${since}): summarising ${todo.map((n) => `#${n}`).join(', ')}.`);
  let out = records;
  for (const n of todo) {
    const { record } = await summarize(getPrInput(n));
    out = upsert(out, preserveVersion(record, have.get(n)));
  }
  return out;
}

// ── The baseline one-shot ───────────────────────────────────────────────────

async function runBaseline(): Promise<void> {
  const records = readStore();
  const versions = readVersions();
  if (records.some((r) => r.version !== null) || versions.some((v) => v.tag === BASELINE_TAG)) {
    throw new Error(
      'Baseline already applied (some records are versioned, or v0.1.0 exists). Refusing — this is a one-shot.',
    );
  }
  if (records.length === 0) {
    throw new Error('Store is empty — run `pnpm changelog:backfill` to seed history first.');
  }

  const releaseDate = resolveReleaseDate();
  const model = hasApiKey() ? currentModel() : null;
  const targetSha = process.env['HEAD_SHA']?.trim() || defaultBranchSha();
  const baseline: VersionRecord = {
    tag: BASELINE_TAG,
    date: releaseDate.toISOString(),
    tier: 'baseline',
    headline: BASELINE_HEADLINE,
    narrative: null,
    prNumbers: records
      .map((r) => r.number)
      .slice()
      .sort((a, b) => a - b),
    targetSha,
    model,
  };
  const body = renderBaseline(records, { model });
  const title = releaseTitle(BASELINE_TAG, BASELINE_HEADLINE);

  console.log(`Baseline: ${title} · ${records.length} records · target ${targetSha.slice(0, 7)}`);
  if (isDryRun()) {
    console.log('\n--- DRY RUN: baseline release body ---\n');
    console.log(body);
    console.log(`\n--- DRY RUN: would stamp all ${records.length} records ${BASELINE_TAG} ---`);
    return;
  }

  writeVersionRelease(BASELINE_TAG, targetSha, title, body);
  const stamped = stampVersion(records, baseline.prNumbers, BASELINE_TAG);
  writeDraft(stamped, [baseline], { model: currentModel() });
  console.log(`\nPublished ${title}; stamped ${records.length} records and emptied Unreleased.`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--baseline')) {
    await runBaseline();
  } else {
    await runCut();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
