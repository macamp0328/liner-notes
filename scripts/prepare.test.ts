// Tests for the prepare-time git-hook installer (scripts/prepare.sh, issue #295).
// Run with `pnpm prepare:test` (node's built-in test runner via tsx — no extra
// dependency, like changelog:test). scripts/ is outside the graph-service
// coverage gate, so these add rigor without affecting service thresholds.
//
// Each case runs prepare.sh in a throwaway temp dir with a fake `husky` shim on
// PATH, so it never touches the real repo's git config. The shim drops a marker
// when invoked, letting us prove husky was — or was not — called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'prepare.sh');

interface RunOptions {
  /**
   * How `.git` appears in the script's cwd:
   * - `'dir'`    — a normal checkout (`.git` is a directory)
   * - `'file'`   — a linked git worktree (`.git` is a file) — exercises the `-e` guard
   * - `'absent'` — no checkout (Docker image build / npm-pack tarball)
   */
  git: 'dir' | 'file' | 'absent';
  /** Body of the fake `husky` shim (it always records that it was invoked first). */
  husky: string;
  /** Env overrides layered over a base that neutralizes ambient CI/HUSKY. */
  env?: Record<string, string>;
}

interface RunResult {
  status: number | null;
  stderr: string;
  huskyCalled: boolean;
}

function run(options: RunOptions): RunResult {
  const work = mkdtempSync(join(tmpdir(), 'prepare-test-'));
  try {
    const repo = join(work, 'repo');
    mkdirSync(repo);
    if (options.git === 'dir') mkdirSync(join(repo, '.git'));
    else if (options.git === 'file')
      // A linked worktree's `.git` is a file pointing at the real gitdir.
      writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');

    const bin = join(work, 'bin');
    mkdirSync(bin);
    const calledMarker = join(repo, 'husky-was-called');
    const shim = `#!/bin/sh\n: > "${calledMarker}"\n${options.husky}\n`;
    const huskyPath = join(bin, 'husky');
    writeFileSync(huskyPath, shim);
    chmodSync(huskyPath, 0o755);

    // Prepend the shim dir, but avoid a trailing `:` (an empty PATH entry = cwd)
    // when the inherited PATH is somehow empty — keeps the harness isolated.
    const basePath = process.env.PATH ?? '';
    const result = spawnSync('sh', [scriptPath], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        // The script-tests CI job sets CI=true; neutralize it (and HUSKY) so a
        // case that means to exercise husky actually does, then layer overrides.
        CI: '',
        HUSKY: '',
        PATH: basePath ? `${bin}:${basePath}` : bin,
        ...options.env,
      },
    });

    return {
      status: result.status,
      stderr: result.stderr ?? '',
      huskyCalled: existsSync(calledMarker),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('skips cleanly with no .git (Docker image build / npm-pack tarball)', () => {
  const r = run({ git: 'absent', husky: 'exit 0' });
  assert.equal(r.status, 0);
  assert.equal(r.huskyCalled, false);
});

test('runs husky when .git is a file (git worktree — guards `-e` against a regression to `-d`)', () => {
  const r = run({ git: 'file', husky: 'exit 0' });
  assert.equal(r.status, 0);
  // `-e` matches a file, so husky runs; a regression to `-d` would skip here.
  assert.equal(r.huskyCalled, true);
});

test('skips when CI is set (runners never commit or push)', () => {
  const r = run({ git: 'dir', husky: 'exit 0', env: { CI: 'true' } });
  assert.equal(r.status, 0);
  assert.equal(r.huskyCalled, false);
});

test('skips on the HUSKY=0 opt-out', () => {
  const r = run({ git: 'dir', husky: 'exit 0', env: { HUSKY: '0' } });
  assert.equal(r.status, 0);
  assert.equal(r.huskyCalled, false);
});

test('propagates a hard husky failure (non-zero exit)', () => {
  const r = run({ git: 'dir', husky: 'echo boom >&2; exit 1' });
  assert.notEqual(r.status, 0);
  assert.equal(r.huskyCalled, true);
  assert.match(r.stderr, /boom/);
  assert.match(r.stderr, /walls are NOT active/);
});

test('catches a husky soft failure (husky v9 exits 0 but emits a diagnostic)', () => {
  const r = run({ git: 'dir', husky: 'echo "git config failed"; exit 0' });
  assert.notEqual(r.status, 0);
  assert.equal(r.huskyCalled, true);
  assert.match(r.stderr, /git config failed/);
  assert.match(r.stderr, /walls are NOT active/);
});

test('succeeds silently when husky installs cleanly', () => {
  const r = run({ git: 'dir', husky: 'exit 0' });
  assert.equal(r.status, 0);
  assert.equal(r.huskyCalled, true);
  assert.equal(r.stderr, '');
});
