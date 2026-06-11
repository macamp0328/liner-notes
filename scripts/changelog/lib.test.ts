// Unit tests for the pure core. Run with `pnpm changelog:test`
// (node's built-in test runner via tsx — no extra dependency). scripts/ is
// outside the graph-service coverage gate, so these add rigor without affecting
// service coverage thresholds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ChangelogRecord,
  isoWeekMonday,
  parsePrNumber,
  parseRecords,
  render,
  serializeRecords,
  upsert,
} from './lib.js';

function rec(overrides: Partial<ChangelogRecord> & { number: number }): ChangelogRecord {
  return {
    title: `task/${overrides.number}: something`,
    url: `https://github.com/o/r/pull/${overrides.number}`,
    author: 'octocat',
    mergedAt: '2026-06-10T12:00:00Z',
    category: 'Changed',
    summary: 'Does a thing.',
    impact: 'developer',
    breaking: false,
    summarySource: 'claude',
    ...overrides,
  };
}

test('parsePrNumber: trailing (#NNN) on the subject line', () => {
  assert.equal(
    parsePrNumber('task/280: make /<stage>/enrich routes async (202 + status poll) (#283)'),
    283,
  );
});

test('parsePrNumber: ignores body lines and earlier parentheticals', () => {
  assert.equal(parsePrNumber('fix: thing (#12)\n\nCloses (#999) which was wrong'), 12);
  assert.equal(parsePrNumber('chore(deps): bump group (a, b) (#268)'), 268);
});

test('parsePrNumber: null when no PR marker (direct push / rewritten message)', () => {
  assert.equal(parsePrNumber('docs: tweak readme'), null);
  assert.equal(parsePrNumber(''), null);
});

test('isoWeekMonday: returns the Monday (UTC) of the week', () => {
  // 2026-06-10 is a Wednesday; its Monday is 2026-06-08.
  assert.equal(isoWeekMonday('2026-06-10T12:00:00Z'), '2026-06-08');
  // Monday maps to itself.
  assert.equal(isoWeekMonday('2026-06-08T00:00:00Z'), '2026-06-08');
});

test('isoWeekMonday: Sunday 23:59 UTC stays in the week that just ended', () => {
  // 2026-06-14 is a Sunday; its Monday is 2026-06-08.
  assert.equal(isoWeekMonday('2026-06-14T23:59:59Z'), '2026-06-08');
  // The next day (Mon) starts a new week.
  assert.equal(isoWeekMonday('2026-06-15T00:00:00Z'), '2026-06-15');
});

test('upsert: replaces by PR number, no duplicate', () => {
  const a = rec({ number: 1, summary: 'first' });
  const a2 = rec({ number: 1, summary: 'rewritten' });
  const result = upsert(upsert([], a), a2);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.summary, 'rewritten');
});

test('upsert: appends a new PR number; original array untouched (pure)', () => {
  const base = upsert([], rec({ number: 1 }));
  const next = upsert(base, rec({ number: 2 }));
  assert.equal(base.length, 1);
  assert.equal(next.length, 2);
});

test('serialize -> parse round-trips and sorts by number', () => {
  const records = [rec({ number: 5 }), rec({ number: 2 }), rec({ number: 9 })];
  const jsonl = serializeRecords(records);
  assert.deepEqual(
    jsonl.split('\n').map((l) => JSON.parse(l).number),
    [2, 5, 9],
  );
  assert.equal(parseRecords(jsonl).length, 3);
});

test('parseRecords: tolerant of blank lines, skips number-less records', () => {
  const jsonl = '\n{"title":"x"}\n{"number":7,"summary":"ok"}\n\n';
  const parsed = parseRecords(jsonl);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.number, 7);
});

test('render: groups by week (newest first), then category; pins breaking', () => {
  const records = [
    rec({ number: 10, mergedAt: '2026-06-09T10:00:00Z', category: 'Fixed', summary: 'Fix A.' }),
    rec({ number: 11, mergedAt: '2026-06-09T11:00:00Z', category: 'Added', summary: 'Add B.' }),
    rec({
      number: 12,
      mergedAt: '2026-06-09T12:00:00Z',
      category: 'Changed',
      summary: 'Break C.',
      breaking: true,
    }),
    rec({ number: 1, mergedAt: '2026-06-02T09:00:00Z', category: 'Docs', summary: 'Doc D.' }),
  ];
  const body = render(records);

  // Newest week heading appears before the older one.
  const wkNew = body.indexOf('### Week of 2026-06-08');
  const wkOld = body.indexOf('### Week of 2026-06-01');
  assert.ok(wkNew >= 0 && wkOld >= 0 && wkNew < wkOld, 'newest week first');

  // Breaking section is pinned above the category sections within the week.
  const breakingHdr = body.indexOf('⚠️ Breaking changes');
  const addedHdr = body.indexOf('**Added**');
  assert.ok(breakingHdr >= 0 && breakingHdr < addedHdr, 'breaking pinned to top of week');

  // Category order: Added before Fixed.
  assert.ok(body.indexOf('**Added**') < body.indexOf('**Fixed**'), 'canonical category order');

  // Lines carry the PR link and author; breaking line is marked.
  assert.match(body, /- Add B\. \(\[#11\]\(https:\/\/github\.com\/o\/r\/pull\/11\)\) — @octocat/);
  assert.match(body, /\*\*⚠️ Breaking:\*\* Break C\./);
});

test('render: deterministic — same records, same bytes', () => {
  const records = [rec({ number: 3 }), rec({ number: 1 }), rec({ number: 2 })];
  assert.equal(render(records), render(records.slice().reverse()));
});

test('render: empty store has a placeholder', () => {
  assert.match(render([]), /No entries yet/);
});
