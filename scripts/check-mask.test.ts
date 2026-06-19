// Tests for the secret-leak guard (scripts/check-mask.sh). Run via
// `pnpm scripts:test` (node's built-in runner through tsx).
//
// check-mask.sh is a CI gate against the ::add-mask:: multi-line anti-pattern:
// masking a whole `aws secretsmanager get-secret-value` JSON blob leaks every
// line after the first to the public Actions log. The detection is a textual
// heuristic, so the false-positive / false-negative matrix below locks in both
// "fails an actual leak" (recall) and "passes safe, correctly-masked code"
// (precision) — the prefix-collision FP (`$json` vs `$jsonValue`) and the
// `.yaml` / global-flag / printf FNs in particular, which a regression could
// silently reopen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const scriptPath = resolve(import.meta.dirname, 'check-mask.sh');

// Runs check-mask.sh against a throwaway workflows dir containing a single
// fixture file, and returns its exit status. status 0 = clean, 1 = violation.
function runAgainst(filename: string, contents: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'check-mask-'));
  try {
    writeFileSync(join(dir, filename), contents);
    const result = spawnSync('bash', [scriptPath, dir], { encoding: 'utf8' });
    return result.status ?? -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertCaught(filename: string, contents: string): void {
  assert.equal(runAgainst(filename, contents), 1, `expected VIOLATION (exit 1) for ${filename}`);
}

function assertClean(filename: string, contents: string): void {
  assert.equal(runAgainst(filename, contents), 0, `expected CLEAN (exit 0) for ${filename}`);
}

// A `run: |` step assembled from shell lines, indented as GitHub Actions YAML.
function workflow(...shellLines: string[]): string {
  const body = shellLines.map((l) => `          ${l}`).join('\n');
  return `jobs:\n  t:\n    steps:\n      - run: |\n${body}\n`;
}

const FETCH = 'json="$(aws secretsmanager get-secret-value --query SecretString --output text)"';

// ── Violations that MUST be caught (recall) ──────────────────────────────────

test('catches echo of the whole blob', () => {
  assertCaught('leak.yml', workflow(FETCH, 'echo "::add-mask::$json"'));
});

test('catches the braced ${json} form', () => {
  assertCaught('leak.yml', workflow(FETCH, 'echo "::add-mask::${json}"'));
});

test('catches a .yaml workflow (GitHub accepts both extensions)', () => {
  assertCaught('leak.yaml', workflow(FETCH, 'echo "::add-mask::$json"'));
});

test('catches a global flag between `aws` and `secretsmanager`', () => {
  const fetch = 'json="$(aws --region us-east-1 secretsmanager get-secret-value --output text)"';
  assertCaught('leak.yml', workflow(fetch, 'echo "::add-mask::$json"'));
});

test('catches a space after $( in the command substitution', () => {
  const fetch = 'json=$( aws secretsmanager get-secret-value --output text)';
  assertCaught('leak.yml', workflow(fetch, 'echo "::add-mask::$json"'));
});

test('catches printf-based masking of the whole blob', () => {
  assertCaught('leak.yml', workflow(FETCH, 'printf "::add-mask::%s\\n" "$json"'));
});

// ── Safe code that MUST stay clean (precision) ───────────────────────────────

test('passes the documented per-field jq loop', () => {
  assertClean(
    'safe.yml',
    workflow(
      FETCH,
      'for k in A B; do',
      '  v="$(printf %s "$json" | jq -r --arg k "$k" ".[$k]")"',
      '  echo "::add-mask::$v"',
      'done',
    ),
  );
});

test('does not flag a jq-extracted scalar whose name is a prefix superset of the blob var', () => {
  // `$json` must not substring-match `$jsonValue`.
  assertClean(
    'safe.yml',
    workflow(
      FETCH,
      'jsonValue="$(printf %s "$json" | jq -r .token)"',
      'echo "::add-mask::$jsonValue"',
    ),
  );
});

test('does not flag a comment that merely documents the anti-pattern', () => {
  assertClean(
    'safe.yml',
    workflow(
      '# never do echo "::add-mask::$json" with a multi-line blob',
      FETCH,
      'v="$(printf %s "$json" | jq -r .a)"',
      'echo "::add-mask::$v"',
    ),
  );
});

test('passes a workflow that fetches no secrets at all', () => {
  assertClean('safe.yml', workflow('echo "::add-mask::$SOME_INPUT"'));
});
