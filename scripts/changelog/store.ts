/* eslint-disable security/detect-child-process -- fixed `gh` binary, array args (no shell). */
// All GitHub I/O, isolated behind `gh`. The changelog has two surfaces:
//   1. The canonical STORE — `changelog.jsonl` (one record per PR) + `versions.json`
//      (one record per cut release) — attached as ASSETS on a single rolling
//      `unreleased` DRAFT release whose body is the live Unreleased preview. A draft
//      never creates a git tag ref, so the store never commits to protected `main`.
//   2. PUBLISHED per-version releases — one real, tagged Release per cut version
//      (vYYYY.MM.DD, plus the v0.1.0 baseline), each body a rendered snapshot of the
//      store. Creating a tag ref can't retrigger any branch-filtered workflow.
// Everything human-facing is a re-render of the store; we never hand-edit a body.
//
// `gh` reads its token from GH_TOKEN / GITHUB_TOKEN (CI) or the local `gh auth`
// session, and infers the repo from the checkout — no extra wiring needed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChangelogRecord,
  type VersionRecord,
  parseRecords,
  parseVersions,
  renderUnreleased,
  serializeRecords,
  serializeVersions,
} from './lib.js';

const RELEASE_TAG = 'unreleased';
const ASSET_NAME = 'changelog.jsonl';
const VERSIONS_ASSET_NAME = 'versions.json';
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

/** Download one asset off the draft release into a fresh temp dir. Null if absent. */
function downloadDraftAsset(assetName: string): string | null {
  if (!releaseExists()) return null;
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  try {
    const ok = tryGh([
      'release',
      'download',
      RELEASE_TAG,
      '--pattern',
      assetName,
      '--dir',
      dir,
      '--clobber',
    ]);
    if (ok === null) return null; // release exists but has no such asset yet
    return readFileSync(join(dir, assetName), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the current record set from the changelog.jsonl asset. Empty if absent. */
export function readStore(): ChangelogRecord[] {
  const raw = downloadDraftAsset(ASSET_NAME);
  return raw === null ? [] : parseRecords(raw);
}

/** Read the version manifest from the versions.json asset. Empty if absent. */
export function readVersions(): VersionRecord[] {
  const raw = downloadDraftAsset(VERSIONS_ASSET_NAME);
  return raw === null ? [] : parseVersions(raw);
}

/**
 * Rewrite the `unreleased` DRAFT: body = the Unreleased preview (pending records),
 * plus the canonical `changelog.jsonl` + `versions.json` assets. This is the single
 * source of truth; published per-version releases are rendered snapshots of it. The
 * draft never creates a git tag (so it never touches protected `main`).
 */
export function writeDraft(
  records: readonly ChangelogRecord[],
  versions: readonly VersionRecord[],
  opts: { model: string | null },
): void {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  try {
    const recordsPath = join(dir, ASSET_NAME);
    const versionsPath = join(dir, VERSIONS_ASSET_NAME);
    const bodyPath = join(dir, 'body.md');
    writeFileSync(recordsPath, `${serializeRecords(records)}\n`);
    writeFileSync(versionsPath, `${serializeVersions(versions)}\n`);
    writeFileSync(bodyPath, renderUnreleased(records, opts));

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
    gh(['release', 'upload', RELEASE_TAG, recordsPath, versionsPath, '--clobber']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function versionReleaseExists(tag: string): boolean {
  return tryGh(['release', 'view', tag, '--json', 'tagName']) !== null;
}

/**
 * Create (or re-render) one PUBLISHED per-version release. On first write,
 * `gh release create <tag> --target <sha>` publishes a real, discoverable release
 * and creates the tag ref at the deployed commit. On a re-render (reconcile),
 * edit body+title only — NEVER pass `--target`, which can move an already-published
 * tag. Throws (via `gh`) if the tag already exists on create — release.ts catches
 * that to recompute the same-day `.N` suffix.
 */
export function writeVersionRelease(
  tag: string,
  targetSha: string,
  title: string,
  body: string,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  try {
    const bodyPath = join(dir, 'body.md');
    writeFileSync(bodyPath, body);
    if (versionReleaseExists(tag)) {
      gh(['release', 'edit', tag, '--title', title, '--notes-file', bodyPath]);
    } else {
      gh([
        'release',
        'create',
        tag,
        '--target',
        targetSha,
        '--title',
        title,
        '--notes-file',
        bodyPath,
      ]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every release tag name (published + draft). Feeds the CalVer `.N` suffix + prev-version lookup. */
export function listReleaseTags(): string[] {
  const json = gh(['release', 'list', '--json', 'tagName', '--limit', String(GH_LIST_LIMIT)]);
  const items = JSON.parse(json) as Array<{ tagName?: string }>;
  return items.map((i) => i.tagName ?? '').filter((t) => t !== '');
}

/** The default-branch HEAD SHA — the baseline release's `--target` when no deploy SHA is given. */
export function defaultBranchSha(): string {
  return gh(['api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha']).trim();
}
