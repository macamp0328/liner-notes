// Unit tests for the pure core. Run with `pnpm changelog:test`
// (node's built-in test runner via tsx — no extra dependency). scripts/ is
// outside the graph-service coverage gate, so these add rigor without affecting
// service coverage thresholds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ChangelogRecord,
  type VersionRecord,
  backfillVersionStamps,
  buildCut,
  calverTag,
  computeStats,
  computeTier,
  disclosureHeader,
  isVersionRecord,
  isoWeekMonday,
  needsSummary,
  parseCalver,
  parsePrNumber,
  parseRecords,
  parseVersions,
  preserveVersion,
  previousVersion,
  recordsByNumber,
  releaseTitle,
  renderBaseline,
  renderUnreleased,
  renderVersion,
  resolvePrNumber,
  serializeRecords,
  serializeVersions,
  stampVersion,
  tierSignals,
  unreleasedRecords,
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
    version: null,
    ...overrides,
  };
}

function vrec(overrides: Partial<VersionRecord> & { tag: string }): VersionRecord {
  return {
    date: '2026-06-11T00:00:00.000Z',
    tier: 'standard',
    headline: 'did stuff',
    narrative: null,
    prNumbers: [1, 2],
    targetSha: 'abc1234',
    model: 'claude-opus-4-8',
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

test('resolvePrNumber: empty/whitespace env is treated as absent, CLI arg wins', () => {
  assert.equal(resolvePrNumber('', '304'), 304); // PR_NUMBER= set-but-blank
  assert.equal(resolvePrNumber('   ', '304'), 304);
  assert.equal(resolvePrNumber(undefined, '304'), 304);
});

test('resolvePrNumber: env wins when present; invalid input → null', () => {
  assert.equal(resolvePrNumber('283', '304'), 283);
  assert.equal(resolvePrNumber('', ''), null);
  assert.equal(resolvePrNumber('abc', undefined), null);
  assert.equal(resolvePrNumber('-5', undefined), null);
  assert.equal(resolvePrNumber('0', undefined), null);
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

test('parseRecords: tolerant — skips blanks, unparseable JSON, and invalid records', () => {
  const good = JSON.stringify(rec({ number: 7 }));
  // blank line, the good record, an unparseable line, and a record missing required fields
  const jsonl = `\n${good}\n{not valid json\n{"number":8,"summary":"missing the rest"}\n\n`;
  const parsed = parseRecords(jsonl); // must NOT throw on the corrupt line
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.number, 7);
});

test('parseRecords: back-compat — a legacy record with no `version` loads as null, not dropped', () => {
  const legacy = JSON.stringify({
    number: 7,
    title: 't',
    url: 'u',
    author: 'a',
    mergedAt: '2026-06-10T12:00:00Z',
    category: 'Changed',
    summary: 's',
    impact: 'developer',
    breaking: false,
    summarySource: 'claude',
    // no `version` key
  });
  const parsed = parseRecords(legacy);
  assert.equal(parsed.length, 1, 'legacy record is not silently dropped');
  assert.equal(parsed[0]?.version, null, 'version defaults to null');
});

test('serialize -> parse round-trips the version stamp', () => {
  const withV = rec({ number: 8, version: 'v2026.06.11' });
  assert.equal(parseRecords(serializeRecords([withV]))[0]?.version, 'v2026.06.11');
});

// ── renderBaseline (legacy week→category layout, frozen) ──────────────────────

test('renderBaseline: groups by week (newest first), then category; pins breaking', () => {
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
  const body = renderBaseline(records, { model: 'claude-opus-4-8' });

  const wkNew = body.indexOf('### Week of 2026-06-08');
  const wkOld = body.indexOf('### Week of 2026-06-01');
  assert.ok(wkNew >= 0 && wkOld >= 0 && wkNew < wkOld, 'newest week first');

  const breakingHdr = body.indexOf('⚠️ Breaking changes');
  const addedHdr = body.indexOf('**Added**');
  assert.ok(breakingHdr >= 0 && breakingHdr < addedHdr, 'breaking pinned to top of week');

  assert.ok(body.indexOf('**Added**') < body.indexOf('**Fixed**'), 'canonical category order');

  // Baseline keeps the author-suffixed line format.
  assert.match(body, /- Add B\. \(\[#11\]\(https:\/\/github\.com\/o\/r\/pull\/11\)\) — @octocat/);
  assert.match(body, /\*\*⚠️ Breaking:\*\* Break C\./);
});

test('renderBaseline: deterministic — same records, same bytes', () => {
  const records = [rec({ number: 3 }), rec({ number: 1 }), rec({ number: 2 })];
  assert.equal(
    renderBaseline(records, { model: null }),
    renderBaseline(records.slice().reverse(), { model: null }),
  );
});

test('renderBaseline: empty store has a placeholder', () => {
  assert.match(renderBaseline([], { model: null }), /No entries yet/);
});

test('renderBaseline: byte-for-byte frozen format (regression lock)', () => {
  const r = rec({
    number: 5,
    mergedAt: '2026-06-10T12:00:00Z',
    category: 'Fixed',
    summary: 'Fix it.',
    author: 'octocat',
    url: 'https://github.com/o/r/pull/5',
  });
  const expected =
    [
      '<!-- Generated by scripts/changelog — do not edit by hand. ' +
        'Source of truth: the changelog.jsonl + versions.json assets on the unreleased draft. -->',
      '',
      '> 🤖 _Auto-generated from merged pull requests — summaries from PR titles (no AI)._',
      '',
      'A plain-English log of everything merged before per-version releases began, newest',
      'week first. Each line is one merged pull request. ⚠️ marks a breaking change.',
      '',
      '### Week of 2026-06-08',
      '',
      '**Fixed**',
      '',
      '- Fix it. ([#5](https://github.com/o/r/pull/5)) — @octocat',
    ].join('\n') + '\n';
  assert.equal(renderBaseline([r], { model: null }), expected);
});

// ── CalVer + versions ─────────────────────────────────────────────────────────

test('calverTag: vYYYY.MM.DD (UTC) with .N suffix on collision', () => {
  const d = new Date('2026-06-11T12:00:00Z');
  assert.equal(calverTag(d, []), 'v2026.06.11');
  assert.equal(calverTag(d, ['v2026.06.11']), 'v2026.06.11.2');
  assert.equal(calverTag(d, ['v2026.06.11', 'v2026.06.11.2']), 'v2026.06.11.3');
  // UTC, not local: a +02:00 instant just after midnight maps to the prior UTC day.
  assert.equal(calverTag(new Date('2026-01-01T00:30:00+02:00'), []), 'v2025.12.31');
});

test('parseCalver: round-trips CalVer, null for non-CalVer', () => {
  assert.deepEqual(parseCalver('v2026.06.11'), { y: 2026, m: 6, d: 11, n: 1 });
  assert.deepEqual(parseCalver('v2026.06.11.3'), { y: 2026, m: 6, d: 11, n: 3 });
  assert.equal(parseCalver('v0.1.0'), null);
  assert.equal(parseCalver('garbage'), null);
});

test('previousVersion: predecessor by (date, tag); cut path (tag absent) → latest', () => {
  const v1 = vrec({ tag: 'v0.1.0', date: '2026-06-11T00:00:00Z' });
  const v2 = vrec({ tag: 'v2026.06.12', date: '2026-06-12T00:00:00Z' });
  const v3 = vrec({ tag: 'v2026.06.13', date: '2026-06-13T00:00:00Z' });
  assert.equal(previousVersion([v1, v2, v3], 'v2026.06.13')?.tag, 'v2026.06.12');
  assert.equal(previousVersion([v1, v2, v3], 'v0.1.0'), null);
  // tag not in list → it's the new cut, predecessor is the current latest
  assert.equal(previousVersion([v1, v2], 'v2026.06.20')?.tag, 'v2026.06.12');
  assert.equal(previousVersion([], 'v2026.06.20'), null);
});

test('version ordering: same-day .N suffix sorts numerically (.10 after .2), not lexically', () => {
  // All same date → the tiebreak is the tag, which must compare NUMERICALLY.
  const base = vrec({ tag: 'v2026.06.11', date: '2026-06-11T00:00:00Z' });
  const n2 = vrec({ tag: 'v2026.06.11.2', date: '2026-06-11T00:00:00Z' });
  const n10 = vrec({ tag: 'v2026.06.11.10', date: '2026-06-11T00:00:00Z' });
  // serializeVersions sorts ascending: base, .2, .10 — NOT the lexical base, .10, .2.
  const order = (JSON.parse(serializeVersions([n10, base, n2])) as VersionRecord[]).map(
    (v) => v.tag,
  );
  assert.deepEqual(order, ['v2026.06.11', 'v2026.06.11.2', 'v2026.06.11.10']);
  // ...so the predecessor of .10 is .2, not the base.
  assert.equal(previousVersion([base, n2, n10], 'v2026.06.11.10')?.tag, 'v2026.06.11.2');
});

test('parseVersions / serializeVersions: round-trip, sorted by date, tolerant', () => {
  const vs = [
    vrec({ tag: 'v2026.06.12', date: '2026-06-12T00:00:00Z' }),
    vrec({ tag: 'v0.1.0', date: '2026-06-11T00:00:00Z' }),
  ];
  const json = serializeVersions(vs);
  assert.deepEqual(
    (JSON.parse(json) as VersionRecord[]).map((v) => v.tag),
    ['v0.1.0', 'v2026.06.12'],
  );
  assert.equal(parseVersions(json).length, 2);
  assert.deepEqual(parseVersions('not json'), []);
  assert.deepEqual(parseVersions('{"not":"an array"}'), []);
  // a malformed entry is filtered, a good one kept
  assert.equal(parseVersions(JSON.stringify([{ tag: 'x' }, vrec({ tag: 'v1' })])).length, 1);
});

test('isVersionRecord: accepts a well-formed record, rejects a partial one', () => {
  assert.equal(isVersionRecord(vrec({ tag: 'v1' })), true);
  assert.equal(isVersionRecord({ tag: 'v1' }), false);
  assert.equal(isVersionRecord(null), false);
});

// ── Tiers ─────────────────────────────────────────────────────────────────────

test('tierSignals: reduces records to breaking/hasAdded/maxImpact/prCount', () => {
  const s = tierSignals([
    rec({ number: 1, category: 'Added', impact: 'user', breaking: true }),
    rec({ number: 2, category: 'Fixed', impact: 'operator' }),
  ]);
  assert.deepEqual(s, { breaking: true, hasAdded: true, maxImpact: 'user', prCount: 2 });
});

test('computeTier: scores the worked examples', () => {
  // one dev-impact docs PR → 0 → maintenance
  assert.equal(
    computeTier([rec({ number: 1, category: 'Docs', impact: 'developer' })]),
    'maintenance',
  );
  // one user-facing Added route → 2+2 = 4 → standard
  assert.equal(computeTier([rec({ number: 1, category: 'Added', impact: 'user' })]), 'standard');
  // breaking user-facing change → 3+2 = 5 → notable
  assert.equal(
    computeTier([rec({ number: 1, category: 'Changed', impact: 'user', breaking: true })]),
    'notable',
  );
  // 5 dev-impact infra PRs → prCount +1 only → maintenance
  const five = [1, 2, 3, 4, 5].map((n) =>
    rec({ number: n, category: 'Infra', impact: 'developer' }),
  );
  assert.equal(computeTier(five), 'maintenance');
  // 8 PRs incl. one Added + operator impact → 2+1+1+1 = 5 → notable
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    rec({ number: n, category: n === 1 ? 'Added' : 'Fixed', impact: 'operator' }),
  );
  assert.equal(computeTier(eight), 'notable');
  // empty → maintenance (defensive)
  assert.equal(computeTier([]), 'maintenance');
});

// ── Version stats ───────────────────────────────────────────────────────────

test('computeStats: PR count + days since prev; null prev → first release', () => {
  const cur = vrec({ tag: 'v2026.06.14', date: '2026-06-14T00:00:00Z', prNumbers: [1, 2, 3] });
  const prev = vrec({ tag: 'v2026.06.11', date: '2026-06-11T00:00:00Z' });
  assert.deepEqual(computeStats(cur, prev), {
    prCount: 3,
    prevTag: 'v2026.06.11',
    daysSincePrev: 3,
  });
  assert.deepEqual(computeStats(cur, null), { prCount: 3, prevTag: null, daysSincePrev: null });
});

// ── Disclosure + title ────────────────────────────────────────────────────────

test('disclosureHeader: names the model, or says "no AI"', () => {
  assert.match(disclosureHeader('claude-opus-4-8'), /summaries by claude-opus-4-8/);
  assert.match(disclosureHeader(null), /no AI/);
});

test('releaseTitle: tag alone, or "tag — headline"', () => {
  assert.equal(releaseTitle('v2026.06.11', 'cool stuff'), 'v2026.06.11 — cool stuff');
  assert.equal(releaseTitle('v2026.06.11', ''), 'v2026.06.11');
  assert.equal(releaseTitle('v2026.06.11', '   '), 'v2026.06.11');
});

// ── renderUnreleased (flat, impact-tagged, no author) ─────────────────────────

test('renderUnreleased: flat list, breaking pinned, impact-tagged, no author, only pending', () => {
  const recs = [
    rec({ number: 11, category: 'Added', summary: 'Add B.', impact: 'user' }),
    rec({ number: 12, summary: 'Break C.', breaking: true, impact: 'operator' }),
    rec({ number: 99, summary: 'Already shipped.', version: 'v0.1.0' }),
  ];
  const body = renderUnreleased(recs, { model: 'claude-opus-4-8' });
  assert.match(body, /## Unreleased/);
  assert.match(body, /summaries by claude-opus-4-8/);
  assert.ok(body.indexOf('Break C.') < body.indexOf('Add B.'), 'breaking pinned');
  assert.match(body, /- Add B\. _\[user\]_ \(\[#11\]\(https:\/\/github\.com\/o\/r\/pull\/11\)\)/);
  assert.ok(!body.includes('@octocat'), 'no author attribution');
  assert.ok(!body.includes('Already shipped.'), 'released records excluded');
});

test('renderUnreleased: placeholder when nothing is pending; deterministic', () => {
  assert.match(renderUnreleased([], { model: null }), /Nothing pending/);
  assert.match(
    renderUnreleased([rec({ number: 1, version: 'v1' })], { model: null }),
    /Nothing pending/,
  );
  const recs = [rec({ number: 1 }), rec({ number: 2 }), rec({ number: 3 })];
  assert.equal(
    renderUnreleased(recs, { model: null }),
    renderUnreleased(recs.slice().reverse(), { model: null }),
  );
});

// ── renderVersion (tier-aware) ────────────────────────────────────────────────

test('renderVersion: notable shows narrative + stats; breaking pinned; impact-tagged', () => {
  const recs = [
    rec({
      number: 11,
      category: 'Added',
      summary: 'Add B.',
      impact: 'user',
      version: 'v2026.06.11',
    }),
    rec({
      number: 12,
      summary: 'Break C.',
      breaking: true,
      impact: 'operator',
      version: 'v2026.06.11',
    }),
  ];
  const stats = { prCount: 2, prevTag: 'v0.1.0', daysSincePrev: 3 };
  const vNotable = vrec({
    tag: 'v2026.06.11',
    tier: 'notable',
    headline: 'big stuff',
    narrative: 'This release does big stuff. Operators must act.',
  });
  const body = renderVersion(vNotable, recs, stats, { model: 'claude-opus-4-8' });
  assert.match(body, /This release does big stuff/);
  assert.match(body, /2 PRs · since v0\.1\.0 \(3 days\)/);
  assert.ok(body.indexOf('Break C.') < body.indexOf('Add B.'), 'breaking pinned');
  assert.match(body, /Add B\. _\[user\]_ \(\[#11\]/);
  assert.ok(!body.includes('@octocat'), 'no author attribution');
});

test('renderVersion: standard/maintenance omit narrative; null prev → first release', () => {
  const recs = [rec({ number: 11, summary: 'A change.', version: 'v2026.06.11' })];
  const vStd = vrec({ tag: 'v2026.06.11', tier: 'standard', headline: 'stuff', narrative: null });
  const body = renderVersion(
    vStd,
    recs,
    { prCount: 1, prevTag: 'v0.1.0', daysSincePrev: 1 },
    {
      model: null,
    },
  );
  assert.match(body, /1 PR · since v0\.1\.0 \(1 day\)/);
  const first = renderVersion(
    vStd,
    recs,
    { prCount: 1, prevTag: null, daysSincePrev: null },
    {
      model: null,
    },
  );
  assert.match(first, /first release/);
});

// ── version stamping helpers ──────────────────────────────────────────────────

test('preserveVersion: keeps a prior stamp; new PRs stay null', () => {
  const fresh = rec({ number: 1, version: null });
  assert.equal(preserveVersion(fresh, rec({ number: 1, version: 'v0.1.0' })).version, 'v0.1.0');
  assert.equal(preserveVersion(fresh, undefined).version, null);
});

test('backfillVersionStamps: stamps from the manifest, leaves others untouched', () => {
  const recs = [
    rec({ number: 1, version: null }),
    rec({ number: 2, version: null }),
    rec({ number: 3, version: 'v0.1.0' }),
  ];
  const stamped = backfillVersionStamps(recs, [vrec({ tag: 'v2026.06.11', prNumbers: [1, 2] })]);
  assert.equal(stamped.find((r) => r.number === 1)?.version, 'v2026.06.11');
  assert.equal(stamped.find((r) => r.number === 2)?.version, 'v2026.06.11');
  assert.equal(stamped.find((r) => r.number === 3)?.version, 'v0.1.0');
});

// ── cutting a version (pure assembly) ─────────────────────────────────────────

test('unreleasedRecords: only version===null; empty when everything has shipped', () => {
  const recs = [rec({ number: 1, version: null }), rec({ number: 2, version: 'v0.1.0' })];
  assert.deepEqual(
    unreleasedRecords(recs).map((r) => r.number),
    [1],
  );
  assert.equal(unreleasedRecords([rec({ number: 9, version: 'v1' })]).length, 0);
});

test('stampVersion: stamps only the listed PRs', () => {
  const recs = [
    rec({ number: 1, version: null }),
    rec({ number: 2, version: null }),
    rec({ number: 3, version: null }),
  ];
  const out = stampVersion(recs, [1, 3], 'v2026.06.11');
  assert.equal(out.find((r) => r.number === 1)?.version, 'v2026.06.11');
  assert.equal(out.find((r) => r.number === 2)?.version, null);
  assert.equal(out.find((r) => r.number === 3)?.version, 'v2026.06.11');
});

test('buildCut: freezes sorted prNumbers/sha/tier; title + body reflect the version', () => {
  const unreleased = [
    rec({ number: 12, summary: 'Break C.', breaking: true, impact: 'operator' }),
    rec({ number: 11, category: 'Added', summary: 'Add B.', impact: 'user' }),
  ];
  const vn = {
    headline: 'big stuff',
    narrative: 'A theme. Why it matters.',
    model: 'claude-opus-4-8',
  };
  const versions = [vrec({ tag: 'v0.1.0', date: '2026-06-08T00:00:00Z' })];
  const cut = buildCut(
    'v2026.06.11',
    'notable',
    vn,
    unreleased,
    new Date('2026-06-11T00:00:00Z'),
    'deadbeef',
    versions,
    'claude-opus-4-8',
  );
  assert.deepEqual(cut.versionRecord.prNumbers, [11, 12], 'prNumbers sorted ascending');
  assert.equal(cut.versionRecord.targetSha, 'deadbeef');
  assert.equal(cut.versionRecord.tier, 'notable');
  assert.equal(cut.title, 'v2026.06.11 — big stuff');
  assert.match(cut.body, /A theme\. Why it matters\./, 'narrative in body for notable');
  assert.match(cut.body, /since v0\.1\.0/);
  assert.ok(cut.body.indexOf('Break C.') < cut.body.indexOf('Add B.'), 'breaking pinned');
});

test('buildCut: disclosure uses the passed model, not vn.model (maintenance bullets are still AI)', () => {
  // The maintenance reality: no version-level AI (vn.model null), but the per-PR
  // summary WAS Claude-written — so the disclosure model is passed explicitly.
  const unreleased = [rec({ number: 7, category: 'Docs', summary: 'A doc tweak.' })];
  const vnFallback = { headline: '1 change', narrative: null, model: null };
  const cut = buildCut(
    'v2026.06.12',
    'maintenance',
    vnFallback,
    unreleased,
    new Date('2026-06-12T00:00:00Z'),
    'cafe',
    [vrec({ tag: 'v0.1.0', date: '2026-06-11T00:00:00Z' })],
    'claude-opus-4-8',
  );
  assert.equal(cut.versionRecord.model, 'claude-opus-4-8', 'record stores the disclosure model');
  assert.match(cut.body, /summaries by claude-opus-4-8/, 'body discloses the model, not "no AI"');
  // ...and a keyless cut honestly says "no AI".
  const keyless = buildCut(
    'v2026.06.12',
    'maintenance',
    vnFallback,
    unreleased,
    new Date('2026-06-12T00:00:00Z'),
    'cafe',
    [],
    null,
  );
  assert.equal(keyless.versionRecord.model, null);
  assert.match(keyless.body, /no AI/);
});

// ── unchanged helpers ─────────────────────────────────────────────────────────

test('recordsByNumber: indexes by PR number', () => {
  const map = recordsByNumber([rec({ number: 3 }), rec({ number: 7 })]);
  assert.equal(map.size, 2);
  assert.equal(map.get(7)?.number, 7);
  assert.equal(map.get(99), undefined);
});

test('needsSummary: a PR not yet in the store always needs summarising', () => {
  assert.equal(needsSummary(undefined, { refresh: false, hasKey: true }), true);
  assert.equal(needsSummary(undefined, { refresh: false, hasKey: false }), true);
});

test('needsSummary: existing fallback upgrades only when a key is available', () => {
  const fb = rec({ number: 1, summarySource: 'fallback' });
  assert.equal(needsSummary(fb, { refresh: false, hasKey: true }), true);
  assert.equal(needsSummary(fb, { refresh: false, hasKey: false }), false);
});

test('needsSummary: existing Claude entry only re-summarises under --refresh', () => {
  const ai = rec({ number: 1, summarySource: 'claude' });
  assert.equal(needsSummary(ai, { refresh: false, hasKey: true }), false);
  assert.equal(needsSummary(ai, { refresh: true, hasKey: true }), true);
  assert.equal(needsSummary(ai, { refresh: true, hasKey: false }), false);
});
