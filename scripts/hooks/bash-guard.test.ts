// Tests for the security-critical PreToolUse guard (.claude/hooks/bash-guard.sh,
// issue #350). Run via `pnpm scripts:test` (node's built-in runner through tsx).
// This hook is the agent-side wall that blocks `git commit --no-verify` and
// `git push --force`/`-f` while allowing `--force-with-lease`; a regex typo could
// silently disable it, so the blocked/allowed/edge matrix is exercised directly.
//
// The hook reads the Bash tool call as JSON on stdin (exit 2 blocks, exit 0
// allows), so each case is fed JSON.stringify({tool_input:{command}}) — the same
// shape the real harness pipes, which is what makes the awk \n-expansion (for
// multi-line/heredoc commands) and the backslash-continuation join meaningful.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const scriptPath = resolve(import.meta.dirname, '..', '..', '.claude', 'hooks', 'bash-guard.sh');

interface RunResult {
  status: number | null;
  stderr: string;
}

function run(command: string): RunResult {
  const result = spawnSync('sh', [scriptPath], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr ?? '' };
}

function assertBlocked(command: string, match: RegExp): void {
  const r = run(command);
  assert.equal(r.status, 2, `expected BLOCKED (exit 2) for: ${command}`);
  assert.match(r.stderr, match);
}

function assertAllowed(command: string): void {
  const r = run(command);
  assert.equal(r.status, 0, `expected ALLOWED (exit 0) for: ${command}\nstderr: ${r.stderr}`);
}

test('blocks git commit --no-verify', () => {
  assertBlocked('git commit --no-verify', /--no-verify/);
});

test('blocks git commit --no-verify even with global options before the subcommand', () => {
  assertBlocked('git -c core.hooksPath=/dev/null commit --no-verify', /--no-verify/);
});

test('blocks plain git push --force', () => {
  assertBlocked('git push --force', /force-push/);
});

test('blocks git push -f', () => {
  assertBlocked('git push -f', /force-push/);
});

test('blocks git -C <path> push --force', () => {
  assertBlocked('git -C /tmp/repo push --force', /force-push/);
});

test('blocks a backslash-continued git push --force (rejoined onto one logical line)', () => {
  // JS '\\\n' is an escaped backslash + a real newline: the JSON-encoded stdin
  // makes the hook's awk expand \n and the continuation-join glue --force back
  // onto the `git push` line. Writing '\n' or '\\n' would silently mis-test.
  assertBlocked('git push \\\n--force', /force-push/);
});

test('blocks --no-verify on the SAME physical line as git commit (documented limitation)', () => {
  assertBlocked('git commit -m "wip --no-verify note"', /--no-verify/);
});

test('allows git push --force-with-lease', () => {
  assertAllowed('git push --force-with-lease');
});

test('allows an ordinary git commit', () => {
  assertAllowed('git commit -m "an ordinary message"');
});

test('allows a plain git push and other git subcommands', () => {
  assertAllowed('git push');
  assertAllowed('git status');
});

test('allows a non-git command that merely contains a blocked flag', () => {
  assertAllowed('echo --no-verify');
});

test('allows "legit commit --no-verify" — the git-word boundary must not match', () => {
  assertAllowed('legit commit --no-verify');
});

test('allows --no-verify mentioned in a heredoc body on a separate physical line', () => {
  // The git commit and the --no-verify mention land on different physical lines
  // after \n-expansion, so line-wise matching does not trip.
  assertAllowed('git commit -m "$(cat <<\'EOF\'\nbody mentions --no-verify\nEOF\n)"');
});
