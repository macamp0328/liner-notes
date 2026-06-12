// Tests for how we handle what the Claude API actually returns — the parsing,
// coercion, and fallback layer. No network: these exercise the pure functions
// that turn a model response (or a missing/garbled one) into a record, plus the
// PR-title fallback. Importing claude.ts is side-effect free (it only makes API
// calls when summarize()/summarizeBatch() are invoked, which these never do).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type PrInput,
  type VersionSummaryInput,
  buildUserPrompt,
  buildVersionPrompt,
  cleanTitle,
  fallbackCategory,
  fallbackVersionNarrative,
  parseSummary,
  parseVersionNarrative,
  recordFromText,
} from './claude.js';
import type { ChangelogRecord } from './lib.js';

function vrecords(): ChangelogRecord[] {
  return [
    {
      number: 11,
      title: 't',
      url: 'u',
      author: 'a',
      mergedAt: '2026-06-10T12:00:00Z',
      category: 'Added',
      summary: 'Adds a route.',
      impact: 'user',
      breaking: false,
      summarySource: 'claude',
      version: null,
    },
  ];
}

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

test('parseSummary: over-long summary is truncated to 320 chars (two-sentence headroom)', () => {
  const long = 'a'.repeat(500);
  const out = parseSummary(
    `{"category":"Added","summary":"${long}","impact":"user","breaking":true}`,
  );
  assert.equal(out?.summary.length, 320);
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

// ── Version-level prose (headline + narrative) ───────────────────────────────

test('buildVersionPrompt: lists changes, tier, prev; asks for narrative only when notable', () => {
  const base: VersionSummaryInput = {
    tag: 'v2026.06.11',
    tier: 'notable',
    records: vrecords(),
    prevTag: 'v0.1.0',
  };
  const notable = buildVersionPrompt(base);
  assert.match(notable, /Version: v2026\.06\.11/);
  assert.match(notable, /Tier: notable/);
  assert.match(notable, /Previous version: v0\.1\.0/);
  assert.match(notable, /- Adds a route\. \(Added, user\)/);
  assert.match(notable, /headline AND a 2–3 sentence narrative/);

  const standard = buildVersionPrompt({ ...base, tier: 'standard', prevTag: null });
  assert.match(standard, /This is the first version\./);
  assert.match(standard, /headline only/);
});

test('parseVersionNarrative: well-formed, missing-narrative, malformed, over-long headline', () => {
  assert.deepEqual(
    parseVersionNarrative('{"headline":"big stuff","narrative":"Why it matters."}'),
    {
      headline: 'big stuff',
      narrative: 'Why it matters.',
    },
  );
  // headline only → narrative null
  assert.deepEqual(parseVersionNarrative('{"headline":"just a headline"}'), {
    headline: 'just a headline',
    narrative: null,
  });
  // empty headline / malformed → null (caller falls back)
  assert.equal(parseVersionNarrative('{"headline":"   "}'), null);
  assert.equal(parseVersionNarrative('not json'), null);
  assert.equal(parseVersionNarrative('["array"]'), null);
  // over-long headline is truncated
  const long = parseVersionNarrative(`{"headline":"${'h'.repeat(300)}"}`);
  assert.equal(long?.headline.length, 100);
});

test('fallbackVersionNarrative: deterministic "N change(s)" headline, no narrative/model', () => {
  assert.deepEqual(fallbackVersionNarrative(1), {
    headline: '1 change',
    narrative: null,
    model: null,
  });
  assert.deepEqual(fallbackVersionNarrative(3), {
    headline: '3 changes',
    narrative: null,
    model: null,
  });
});
