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
  parseRecordsStrict,
  parseVersionsStrict,
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

/** stderr text off a thrown execFileSync error (utf8 string or Buffer). */
function ghStderr(err: unknown): string {
  const e = err as { stderr?: string | Buffer };
  return e.stderr ? e.stderr.toString() : '';
}

// ── Transient-failure retry (reads only) ─────────────────────────────────────
//
// GitHub's release-asset CDN periodically resets connections mid-download
// ("connection reset by peer"), and one blip used to red the whole changelog job
// because the store deliberately throws loud rather than degrade a read to empty.
// Retrying keeps that invariant — a read still NEVER silently reads as empty — it
// just gives a transient blip a couple of chances to clear first. Only idempotent
// READS retry; writes stay single-shot (`release create` is not idempotent, and
// release.ts relies on catching its "already exists" failure to recompute the
// same-day `.N` tag suffix).

const GH_RETRY_ATTEMPTS = 3;
const GH_RETRY_BASE_DELAY_MS = 2000;

/** Sync sleep — this module is execFileSync-based throughout, so no event loop to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `run`, retrying with exponential backoff on failure. `isExpectedFailure`
 * (matched against the error's stderr) short-circuits the retries for failures that
 * are semantically meaningful to the caller — e.g. "release not found", which is a
 * legitimate answer, not a blip. The ORIGINAL error object is always what propagates
 * (never wrapped), so callers can still classify it by stderr. Pure decision logic
 * with injectable sleep/warn so the retry behaviour is unit-testable without gh.
 */
export function retryTransient<T>(
  run: () => T,
  opts: {
    label: string;
    attempts?: number;
    isExpectedFailure?: (stderr: string) => boolean;
    sleep?: (ms: number) => void;
    warn?: (message: string) => void;
  },
): T {
  const attempts = opts.attempts ?? GH_RETRY_ATTEMPTS;
  const sleep = opts.sleep ?? sleepSync;
  const warn = opts.warn ?? console.warn;
  for (let attempt = 1; ; attempt++) {
    try {
      return run();
    } catch (err) {
      if (opts.isExpectedFailure?.(ghStderr(err))) throw err;
      if (attempt >= attempts) throw err;
      const delayMs = GH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      warn(
        `${opts.label} failed (attempt ${attempt}/${attempts}) — transient? retrying in ${delayMs / 1000}s…`,
      );
      sleep(delayMs);
    }
  }
}

/** Read-only gh call with transient-failure retry. Use `gh()` directly for writes. */
function ghRead(args: string[], isExpectedFailure?: (stderr: string) => boolean): string {
  return retryTransient(() => gh(args), {
    label: `gh ${args.slice(0, 3).join(' ')}`,
    // exactOptionalPropertyTypes: only pass the key when a predicate was given.
    ...(isExpectedFailure ? { isExpectedFailure } : {}),
  });
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
  const json = ghRead([
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
  const json = ghRead([
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
  const json = ghRead([
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

interface GhReleaseAssets {
  assets?: Array<{ name?: string }>;
}

/**
 * Classify a failed `gh release view`: a genuine "release not found" (the draft is
 * absent — a legitimate empty) vs ANY other failure (network / 5xx / rate-limit /
 * auth), which must NOT be mistaken for absence and silently degrade a read to empty.
 * Pure + exported so the bug-prone classification is unit-tested without invoking gh.
 * gh prints exactly `release not found` (exit 1) for a missing release.
 */
export function isReleaseNotFound(stderr: string): boolean {
  return /release not found|HTTP 404/i.test(stderr);
}

/**
 * `gh release view <RELEASE_TAG> --json <fields>` → the JSON string, or `null` ONLY
 * when gh reports the release genuinely doesn't exist. Any OTHER gh failure is
 * retried (transient) and, if it persists, THROWS — the load-bearing distinction that
 * stops a transient blip being read as "absent" and wiping the canonical assets on
 * the next write-back. (The previous code used the error-swallowing `tryGh` here, so
 * a transient view failure looked identical to absence — the hole this closes.)
 */
function viewReleaseJson(fields: string): string | null {
  try {
    return ghRead(['release', 'view', RELEASE_TAG, '--json', fields], isReleaseNotFound);
  } catch (err) {
    if (isReleaseNotFound(ghStderr(err))) return null;
    throw new Error(
      `gh release view ${RELEASE_TAG} failed and it is NOT "release not found" — refusing to ` +
        'read it as absence (a write-back over an empty read would wipe the store). The call was ' +
        `already retried ${GH_RETRY_ATTEMPTS}× internally, so the failure is persisting — ` +
        `investigate before re-running. Details: ${ghStderr(err) || (err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Asset names attached to the draft release, or `null` when the draft genuinely
 * doesn't exist. Lets a reader tell "asset never uploaded" (legitimate empty) from a
 * transient failure (which `viewReleaseJson` raises). A JSON.parse failure here is gh
 * returning success with garbage — real corruption, so it throws, not swallowed.
 */
function releaseAssetNames(): string[] | null {
  const json = viewReleaseJson('assets');
  if (json === null) return null; // release genuinely absent
  const parsed = JSON.parse(json) as GhReleaseAssets;
  return (parsed.assets ?? []).map((a) => a.name ?? '').filter((n) => n !== '');
}

/**
 * Download one LISTED asset into a fresh temp dir and return its contents. The
 * caller has already confirmed the asset exists, so a failure here is transient
 * (the release-asset CDN is the flakiest gh path we hit) — retried, and if it
 * persists it throws: loud, never an empty read.
 */
function downloadAsset(assetName: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
  try {
    ghRead(['release', 'download', RELEASE_TAG, '--pattern', assetName, '--dir', dir, '--clobber']);
    return readFileSync(join(dir, assetName), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Raw text of one store asset for a read-modify-write caller, or `null` if it is
 * GENUINELY absent (no draft yet, or never uploaded). Throws on any transient gh
 * failure (view or download) — never degrades to empty, the corruption class this
 * module guards against. Parse strictness (drop vs throw on a corrupt line) is the
 * caller's choice, applied to the returned text.
 */
function fetchAsset(assetName: string): string | null {
  const names = releaseAssetNames();
  if (names === null) return null; // draft release doesn't exist yet
  if (!names.includes(assetName)) return null; // asset never uploaded yet
  return downloadAsset(assetName);
}

/**
 * STRICT read of the record set — for the read side of a read-modify-write
 * (update/release). A truncated/corrupt asset throws rather than yielding a smaller
 * set a writer would persist back. Empty only if the asset is genuinely absent.
 */
export function readStore(): ChangelogRecord[] {
  const raw = fetchAsset(ASSET_NAME);
  return raw === null ? [] : parseRecordsStrict(raw);
}

/**
 * TOLERANT read of the record set — for the RECOVERY callers (reconcile/backfill).
 * A persisted corrupt line is DROPPED so the recovery path can still run and re-add
 * it from the source-of-truth PRs, instead of throwing on the very corruption it
 * exists to repair. Transient gh failures still throw (via `fetchAsset`); only bad
 * bytes already on the asset are tolerated. Records are re-derivable — versions are
 * not, which is why there is no tolerant `readVersions`.
 */
export function readStoreTolerant(): ChangelogRecord[] {
  const raw = fetchAsset(ASSET_NAME);
  return raw === null ? [] : parseRecords(raw);
}

/**
 * Read the version manifest — ALWAYS strict. A VersionRecord's frozen
 * headline/narrative/tier/targetSha lives nowhere else, so a malformed entry must
 * never be silently dropped and persisted back (no tolerant variant, by design).
 * Empty only if genuinely absent.
 */
export function readVersions(): VersionRecord[] {
  const raw = fetchAsset(VERSIONS_ASSET_NAME);
  return raw === null ? [] : parseVersionsStrict(raw);
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
  const json = ghRead(['release', 'list', '--json', 'tagName', '--limit', String(GH_LIST_LIMIT)]);
  const items = JSON.parse(json) as Array<{ tagName?: string }>;
  return items.map((i) => i.tagName ?? '').filter((t) => t !== '');
}

/** The default-branch HEAD SHA — the baseline release's `--target` when no deploy SHA is given. */
export function defaultBranchSha(): string {
  return ghRead(['api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha']).trim();
}
