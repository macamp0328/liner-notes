/* eslint-disable security/detect-child-process -- fixed `gh` binary, array args (no shell). */
// All GitHub I/O, isolated behind `gh`. The changelog "store" is a single
// `changelog.jsonl` file attached as an ASSET on the rolling `unreleased` draft
// release — so the source of truth lives in the Releases surface and never
// commits to protected `main`. The human-readable release body is always a full
// re-render of that store (see lib.render); we never edit the body by hand.
//
// `gh` reads its token from GH_TOKEN / GITHUB_TOKEN (CI) or the local `gh auth`
// session, and infers the repo from the checkout — no extra wiring needed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChangelogRecord, parseRecords, render, serializeRecords } from './lib.js';

const RELEASE_TAG = 'unreleased';
const ASSET_NAME = 'changelog.jsonl';
const MAX_FILES_IN_DIFFSTAT = 40;
const GH_LIST_LIMIT = 1000;

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Probe form: swallow stderr too, so an expected "release not found" / missing
// asset doesn't leak alarming output for the normal first-run / empty case.
function tryGh(args: string[]): string | null {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// ── PR fetching ──────────────────────────────────────────────────────────────

interface GhPrView {
  title?: string;
  body?: string;
  url?: string;
  author?: { login?: string } | null;
  mergedAt?: string;
  labels?: Array<{ name?: string }>;
  files?: Array<{ path?: string; additions?: number; deletions?: number }>;
}

function diffstat(files: GhPrView['files']): string {
  if (!files || files.length === 0) return '';
  const shown = files
    .slice(0, MAX_FILES_IN_DIFFSTAT)
    .map((f) => `${f.path ?? '?'}  +${f.additions ?? 0} -${f.deletions ?? 0}`);
  if (files.length > MAX_FILES_IN_DIFFSTAT) {
    shown.push(`…and ${files.length - MAX_FILES_IN_DIFFSTAT} more files`);
  }
  return shown.join('\n');
}

export interface PrInputRaw {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  mergedAt: string;
  labels: string[];
  filesSummary: string;
}

/** Fetch the fields we summarise from for one PR. */
export function getPrInput(number: number): PrInputRaw {
  const json = gh([
    'pr',
    'view',
    String(number),
    '--json',
    'title,body,url,author,mergedAt,labels,files',
  ]);
  const pr = JSON.parse(json) as GhPrView;
  return {
    number,
    title: pr.title ?? `PR #${number}`,
    body: pr.body ?? '',
    url: pr.url ?? '',
    author: pr.author?.login ?? 'unknown',
    mergedAt: pr.mergedAt ?? '',
    labels: (pr.labels ?? []).map((l) => l.name ?? '').filter((n) => n !== ''),
    filesSummary: diffstat(pr.files),
  };
}

interface GhPrListItem {
  number: number;
  mergedAt?: string;
}

/** Merged PR numbers (+ merge time) since an ISO date — the reconciler's candidate set. */
export function listMergedPrNumbers(sinceIso: string): Array<{ number: number; mergedAt: string }> {
  const json = gh([
    'pr',
    'list',
    '--state',
    'merged',
    '--search',
    `merged:>=${sinceIso}`,
    '--json',
    'number,mergedAt',
    '--limit',
    String(GH_LIST_LIMIT),
  ]);
  const items = JSON.parse(json) as GhPrListItem[];
  return items.map((i) => ({ number: i.number, mergedAt: i.mergedAt ?? '' }));
}

/** Every merged PR number (for backfill). Capped at GH_LIST_LIMIT; logs if hit. */
export function listAllMergedPrNumbers(): number[] {
  const json = gh([
    'pr',
    'list',
    '--state',
    'merged',
    '--json',
    'number',
    '--limit',
    String(GH_LIST_LIMIT),
  ]);
  const items = JSON.parse(json) as GhPrListItem[];
  if (items.length === GH_LIST_LIMIT) {
    console.warn(
      `Hit the ${GH_LIST_LIMIT}-PR list cap — older PRs were not enumerated. ` +
        'Run the reconciler with an explicit older --since to backfill the tail.',
    );
  }
  return items.map((i) => i.number);
}

// ── Store read/write (release asset + body) ──────────────────────────────────

function releaseExists(): boolean {
  return tryGh(['release', 'view', RELEASE_TAG, '--json', 'tagName']) !== null;
}

/** Read the current record set from the release asset. Empty if absent. */
export function readStore(): ChangelogRecord[] {
  if (!releaseExists()) return [];
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  try {
    const ok = tryGh([
      'release',
      'download',
      RELEASE_TAG,
      '--pattern',
      ASSET_NAME,
      '--dir',
      dir,
      '--clobber',
    ]);
    if (ok === null) return []; // release exists but has no asset yet
    return parseRecords(readFileSync(join(dir, ASSET_NAME), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Render the body from `records`, then write both the body and the jsonl asset. */
export function writeStore(records: readonly ChangelogRecord[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  try {
    const assetPath = join(dir, ASSET_NAME);
    const bodyPath = join(dir, 'body.md');
    writeFileSync(assetPath, `${serializeRecords(records)}\n`);
    writeFileSync(bodyPath, render(records));

    if (releaseExists()) {
      gh(['release', 'edit', RELEASE_TAG, '--notes-file', bodyPath]);
    } else {
      gh([
        'release',
        'create',
        RELEASE_TAG,
        '--draft',
        '--title',
        'Changelog (unreleased)',
        '--notes-file',
        bodyPath,
      ]);
    }
    gh(['release', 'upload', RELEASE_TAG, assetPath, '--clobber']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
