// Tests for how we handle what the Claude API actually returns — the parsing,
// coercion, and fallback layer. No network: these exercise the pure functions
// that turn a model response (or a missing/garbled one) into a record, plus the
// PR-title fallback. Importing claude.ts is side-effect free (it only makes API
// calls when summarize()/summarizeBatch() are invoked, which these never do).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type PrInput,
  buildUserPrompt,
  cleanTitle,
  fallbackCategory,
  parseSummary,
  recordFromText,
} from './claude.js';

function pr(overrides: Partial<PrInput> = {}): PrInput {
  return {
    number: 42,
    title: 'task/40: do the thing',
    body: 'A body.',
    url: 'https://github.com/o/r/pull/42',
    author: 'octocat',
    mergedAt: '2026-06-10T12:00:00Z',
    labels: [],
    filesSummary: '',
    ...overrides,
  };
}

// ── parseSummary: trust nothing the model returns ───────────────────────────

test('parseSummary: well-formed response maps straight through', () => {
  const out = parseSummary(
    '{"category":"Fixed","summary":"Fixes a crash.","impact":"user","breaking":false}',
  );
  assert.deepEqual(out, {
    category: 'Fixed',
    summary: 'Fixes a crash.',
    impact: 'user',
    breaking: false,
  });
});

test('parseSummary: unknown category/impact coerce to safe defaults', () => {
  const out = parseSummary('{"category":"Bogus","summary":"x","impact":"alien","breaking":false}');
  assert.equal(out?.category, 'Changed');
  assert.equal(out?.impact, 'developer');
});

test('parseSummary: non-string summary becomes empty (caller will fall back)', () => {
  assert.equal(
    parseSummary('{"category":"Added","summary":123,"impact":"user","breaking":false}')?.summary,
    '',
  );
  assert.equal(parseSummary('{"category":"Added","impact":"user","breaking":false}')?.summary, '');
});

test('parseSummary: over-long summary is truncated to 240 chars', () => {
  const long = 'a'.repeat(500);
  const out = parseSummary(
    `{"category":"Added","summary":"${long}","impact":"user","breaking":true}`,
  );
  assert.equal(out?.summary.length, 240);
});

test('parseSummary: breaking is only true for a real boolean true', () => {
  assert.equal(parseSummary('{"summary":"x","breaking":"true"}')?.breaking, false);
  assert.equal(parseSummary('{"summary":"x","breaking":1}')?.breaking, false);
  assert.equal(parseSummary('{"summary":"x","breaking":true}')?.breaking, true);
});

test('parseSummary: malformed JSON or non-object returns null (never throws)', () => {
  assert.equal(parseSummary('not json at all'), null);
  assert.equal(parseSummary('{"summary": "unterminated'), null);
  assert.equal(parseSummary('["array"]'), null);
  assert.equal(parseSummary('"a string"'), null);
  assert.equal(parseSummary('42'), null);
});

// ── recordFromText: the safety net the batch depends on ─────────────────────

test('recordFromText: good response → a Claude-sourced record', () => {
  const r = recordFromText(
    pr({ number: 7 }),
    '{"category":"Added","summary":"Adds a route.","impact":"user","breaking":false}',
  );
  assert.equal(r.summarySource, 'claude');
  assert.equal(r.summary, 'Adds a route.');
  assert.equal(r.category, 'Added');
  assert.equal(r.number, 7);
});

test('recordFromText: malformed response → PR-title fallback, not a throw', () => {
  const r = recordFromText(pr({ title: 'fix: handle nulls' }), 'garbage{');
  assert.equal(r.summarySource, 'fallback');
  assert.equal(r.summary, 'Handle nulls');
  assert.equal(r.category, 'Fixed');
});

test('recordFromText: empty summary → fallback (never a blank changelog line)', () => {
  const r = recordFromText(
    pr({ title: 'docs: tidy readme' }),
    '{"category":"Docs","summary":"   ","impact":"developer","breaking":false}',
  );
  assert.equal(r.summarySource, 'fallback');
  assert.equal(r.summary, 'Tidy readme');
});

// ── Fallback quality (used whenever Claude is unavailable) ───────────────────

test('cleanTitle: strips conventional/task prefixes and capitalises', () => {
  assert.equal(cleanTitle('task/280: make routes async'), 'Make routes async');
  assert.equal(cleanTitle('fix(deploy): numeric runAsUser'), 'Numeric runAsUser');
  assert.equal(cleanTitle('chore(deps): bump group'), 'Bump group');
  assert.equal(cleanTitle('plain title'), 'Plain title');
});

test('fallbackCategory: infers from the conventional-commit prefix', () => {
  assert.equal(fallbackCategory('fix: x'), 'Fixed');
  assert.equal(fallbackCategory('docs: x'), 'Docs');
  assert.equal(fallbackCategory('chore(deps): x'), 'Infra');
  assert.equal(fallbackCategory('ci: x'), 'Infra');
  assert.equal(fallbackCategory('feat: x'), 'Added');
  assert.equal(fallbackCategory('task/1: x'), 'Changed');
});

// ── What we send to Claude (input quality drives output quality) ─────────────

test('buildUserPrompt: includes title, labels, diffstat, and body', () => {
  const text = buildUserPrompt(
    pr({
      number: 99,
      title: 'feat: add export',
      labels: ['enhancement', 'api'],
      filesSummary: 'src/a.ts  +10 -2',
      body: 'Adds CSV export.',
    }),
  );
  assert.match(text, /PR #99: feat: add export/);
  assert.match(text, /enhancement, api/);
  assert.match(text, /src\/a\.ts {2}\+10 -2/);
  assert.match(text, /Adds CSV export\./);
});
