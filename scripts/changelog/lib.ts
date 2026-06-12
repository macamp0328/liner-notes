// Pure, I/O-free core of the changelog system. Everything here is a deterministic
// function of its inputs so it can be exhaustively unit-tested (lib.test.ts) and
// so that re-rendering the same records always produces byte-identical output —
// the property that makes the two writers (the per-merge hook and the weekly
// reconciler) idempotent and lets them converge on the same release body.
//
// The data model: ONE record per merged PR, keyed by `number`. The human-facing
// release body is always a full `render()` of the record set — never hand-edited
// string surgery — so a missed or replayed PR can never duplicate or corrupt an
// entry. See scripts/changelog/README.md for the architecture.

export const CATEGORIES = [
  'Added',
  'Changed',
  'Fixed',
  'Removed',
  'Security',
  'Infra',
  'Docs',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const IMPACTS = ['user', 'operator', 'developer'] as const;
export type Impact = (typeof IMPACTS)[number];

export type SummarySource = 'claude' | 'fallback';

/** One merged PR, summarised. The unit of the changelog store. */
export interface ChangelogRecord {
  /** PR number — the idempotency key. */
  number: number;
  /** Original PR title (kept for traceability / fallback rendering). */
  title: string;
  /** Web URL of the PR. */
  url: string;
  /** GitHub login of the author (no leading @). */
  author: string;
  /** ISO-8601 merge timestamp. Drives weekly grouping. */
  mergedAt: string;
  category: Category;
  /** One plain-English sentence. No markdown, no PR-number prefix. */
  summary: string;
  impact: Impact;
  breaking: boolean;
  /** Whether the summary came from Claude or the no-API-key fallback. */
  summarySource: SummarySource;
  /**
   * The CalVer tag this PR was released under (e.g. "v2026.06.11"), or `null`
   * while it is still unreleased. Stamped by `release.ts` when a version is cut.
   * Optional on disk for back-compat — `normalizeRecord` fills `null` for records
   * written before this field existed (see `parseRecords`).
   */
  version: string | null;
}

export const TIERS = ['maintenance', 'standard', 'notable'] as const;
/** A tier `computeTier` can produce from a set of records. */
export type ComputedTier = (typeof TIERS)[number];
/** All tiers, including the `baseline` migration sentinel (never computed). */
export type Tier = ComputedTier | 'baseline';

export function isTier(value: unknown): value is Tier {
  return (
    typeof value === 'string' &&
    (value === 'baseline' || (TIERS as readonly string[]).includes(value))
  );
}

/**
 * Version-level metadata for one cut release, keyed by `tag`. Stored as the
 * `versions.json` asset alongside `changelog.jsonl` on the unreleased draft.
 * Everything a renderer needs is FROZEN here at cut time (headline, narrative,
 * tier, model) so the reconciler can re-render any published release
 * deterministically with NO new AI calls — the release-world analog of the
 * repo's other fail-on-drift, derived-output guards.
 */
export interface VersionRecord {
  /** CalVer tag (e.g. "v2026.06.11", "v2026.06.11.2") or the "v0.1.0" baseline. Primary key. */
  tag: string;
  /** ISO-8601 cut time. Drives "since vPrev" stats and version ordering. */
  date: string;
  tier: Tier;
  /** The descriptive part of the release title (no tag prefix). "" when none (maintenance). */
  headline: string;
  /** 2–3 sentence lede for Notable releases; null otherwise. */
  narrative: string | null;
  /** PR numbers in this version, ascending. Join key back to ChangelogRecord. */
  prNumbers: number[];
  /** The deployed commit this version tags. */
  targetSha: string;
  /**
   * Disclosure model — the model whose voice this release reflects (its per-PR
   * summaries, and any headline/narrative), or null when no key was set so every
   * summary was a PR-title fallback. Drives the body's "summaries by …" line.
   */
  model: string | null;
}

/**
 * The version-level prose for one cut: the headline (release-title suffix) and an
 * optional narrative, plus the model that produced them. Returned by the AI layer
 * (`summarizeVersion`) or the deterministic fallback; consumed by `buildCut`.
 */
export interface VersionNarrative {
  /** Descriptive title suffix (no tag prefix); `${n} change(s)` on fallback. */
  headline: string;
  /** 2–3 sentence lede (Notable only); null otherwise. */
  narrative: string | null;
  /** Model that wrote it, or null (fallback / no key). */
  model: string | null;
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export function isImpact(value: unknown): value is Impact {
  return typeof value === 'string' && (IMPACTS as readonly string[]).includes(value);
}

/**
 * Extract the PR number from a squash-merge commit message. GitHub appends
 * `(#NNN)` to the subject line of every squash merge; the body may contain
 * other parenthesised text (e.g. `(202 + status poll)`), so we anchor on the
 * trailing `(#NNN)` of the FIRST line only. Returns null when absent (a direct
 * push, or a manually rewritten message) so callers can skip cleanly.
 */
export function parsePrNumber(commitMessage: string): number | null {
  const firstLine = commitMessage.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/\(#(\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}

/**
 * Resolve a PR number for `update` from the PR_NUMBER env (CI) or a CLI arg
 * (manual run). Empty/whitespace is treated as **absent** — not `??`-defined — so
 * a stray `PR_NUMBER=` in the shell or an env file doesn't shadow `update <n>`.
 * Returns null for missing/invalid input so the caller can show a usage hint.
 */
export function resolvePrNumber(
  envValue: string | undefined,
  argValue: string | undefined,
): number | null {
  const raw = envValue?.trim() || argValue?.trim() || '';
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The Monday (UTC) of the ISO week containing `isoDate`, formatted `YYYY-MM-DD`.
 * Weeks are Monday-based and computed in UTC so an entry merged at 23:59 Sunday
 * UTC lands in the week that just ended, deterministically — never a local-tz
 * boundary flake.
 */
export function isoWeekMonday(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`isoWeekMonday: invalid date "${isoDate}"`);
  }
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayFromMonday = (utc.getUTCDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0, ...
  utc.setUTCDate(utc.getUTCDate() - dayFromMonday);
  return utc.toISOString().slice(0, 10);
}

/**
 * Insert or replace a record by PR number, returning a NEW array (callers stay
 * pure). Replacement-in-place preserves position; a new PR is appended. Storage
 * order is irrelevant — `render()` sorts — but stability keeps diffs small.
 */
export function upsert(
  records: readonly ChangelogRecord[],
  record: ChangelogRecord,
): ChangelogRecord[] {
  const next = records.slice();
  const idx = next.findIndex((r) => r.number === record.number);
  if (idx >= 0) {
    next[idx] = record;
  } else {
    next.push(record);
  }
  return next;
}

/** Index a record set by PR number — for fast "do we already have this PR?" lookups. */
export function recordsByNumber(records: readonly ChangelogRecord[]): Map<number, ChangelogRecord> {
  return new Map(records.map((r) => [r.number, r]));
}

/**
 * Re-summarising a PR rebuilds its record from scratch with `version: null`. When
 * the PR was already released, carry its existing `version` forward so a refresh or
 * a reconcile heal never silently moves a shipped entry back to Unreleased. New PRs
 * (no prior) stay `null`.
 */
export function preserveVersion(
  record: ChangelogRecord,
  prior: ChangelogRecord | undefined,
): ChangelogRecord {
  return prior ? { ...record, version: prior.version } : record;
}

/**
 * Re-derive every record's `version` from the version manifest: a record whose PR
 * number is in a VersionRecord's `prNumbers` gets stamped with that tag. Closes the
 * publish-then-stamp crash window in `release.ts` (a release published but its
 * records left `null`), deterministically and with no AI. Pure: returns a new array.
 */
export function backfillVersionStamps(
  records: readonly ChangelogRecord[],
  versions: readonly VersionRecord[],
): ChangelogRecord[] {
  const tagByPr = new Map<number, string>();
  for (const v of versions) {
    for (const n of v.prNumbers) tagByPr.set(n, v.tag);
  }
  return records.map((r) => {
    const tag = tagByPr.get(r.number);
    return tag && r.version !== tag ? { ...r, version: tag } : r;
  });
}

/**
 * Decide whether a PR needs (re)summarising:
 *   - a PR not yet in the store → always (it gets a Claude summary, or a fallback if no key);
 *   - an existing **fallback** (PR-title) entry → yes, but only when a key is available to
 *     improve it (so a keyless run doesn't churn title→title);
 *   - an existing Claude entry → only when `refresh` is set (e.g. the editorial style changed).
 * This is what lets backfill/reconcile upgrade title-only entries to real summaries once the
 * key is present, without re-doing work that's already good.
 */
export function needsSummary(
  existing: ChangelogRecord | undefined,
  opts: { refresh: boolean; hasKey: boolean },
): boolean {
  if (!existing) return true;
  if (!opts.hasKey) return false;
  if (opts.refresh) return true;
  return existing.summarySource === 'fallback';
}

// ── CalVer tags ───────────────────────────────────────────────────────────────

/**
 * `vYYYY.MM.DD` for `date` (UTC, matching `isoWeekMonday`'s convention). When the
 * base tag is already taken, append the lowest `.N` (N≥2) that isn't — so a second
 * deploy on the same day becomes `…DD.2`, a third `…DD.3`. Pure: caller supplies
 * the set of existing tags (release.ts unions live `gh` tags with `versions.json`).
 */
export function calverTag(date: Date, existingTags: readonly string[]): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const base = `v${y}.${m}.${d}`;
  const taken = new Set(existingTags);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
}

/** Parse a CalVer tag → `{ y, m, d, n }` (n defaults to 1). Null for non-CalVer (e.g. `v0.1.0`). */
export function parseCalver(tag: string): { y: number; m: number; d: number; n: number } | null {
  // Fully anchored, fixed-width digit groups with a single optional
  // `(?:\.(\d+))?` tail; no backtracking blow-up. safe-regex false-positives on
  // the `\d{N}` quantifiers.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = tag.match(/^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    n: match[4] ? Number(match[4]) : 1,
  };
}

/**
 * The version immediately before `tag` in (date, tag) order. When `tag` is not in
 * `versions` (the cut path — the new VersionRecord isn't appended yet), it's the
 * newest existing version, so we return the last one. Null when there is none
 * (the very first version, before any baseline).
 */
export function previousVersion(
  versions: readonly VersionRecord[],
  tag: string,
): VersionRecord | null {
  const sorted = [...versions].sort(byDateThenTag);
  const idx = sorted.findIndex((v) => v.tag === tag);
  if (idx === -1) return sorted.length > 0 ? (sorted[sorted.length - 1] ?? null) : null;
  return idx > 0 ? (sorted[idx - 1] ?? null) : null;
}

// ── Importance tiers ──────────────────────────────────────────────────────────

const IMPACT_RANK: Record<Impact, number> = { developer: 0, operator: 1, user: 2 };

export interface TierSignals {
  breaking: boolean;
  hasAdded: boolean;
  maxImpact: Impact;
  prCount: number;
}

/** Reduce a version's records to the signals `computeTier` scores. */
export function tierSignals(records: readonly ChangelogRecord[]): TierSignals {
  let breaking = false;
  let hasAdded = false;
  let maxImpact: Impact = 'developer';
  for (const r of records) {
    if (r.breaking) breaking = true;
    if (r.category === 'Added') hasAdded = true;
    if (IMPACT_RANK[r.impact] > IMPACT_RANK[maxImpact]) maxImpact = r.impact;
  }
  return { breaking, hasAdded, maxImpact, prCount: records.length };
}

/**
 * How richly a release should be written, derived deterministically from its
 * records so a reconcile re-render is reproducible. Additive score:
 *   breaking +3 · any Added +2 · max impact user +2 / operator +1 / developer +0 ·
 *   ≥4 PRs +1 · ≥8 PRs +1 (cumulative).
 * Thresholds: ≥5 → notable, ≥2 → standard, else maintenance. Empty → maintenance
 * (defensive; release.ts skips an empty cut). Diffstat/churn is deliberately NOT
 * a signal — the store doesn't carry it, and the category/impact/breaking signals
 * capture importance well enough.
 */
export function computeTier(records: readonly ChangelogRecord[]): ComputedTier {
  if (records.length === 0) return 'maintenance';
  const s = tierSignals(records);
  let score = 0;
  if (s.breaking) score += 3;
  if (s.hasAdded) score += 2;
  score += IMPACT_RANK[s.maxImpact];
  if (s.prCount >= 4) score += 1;
  if (s.prCount >= 8) score += 1;
  if (score >= 5) return 'notable';
  if (score >= 2) return 'standard';
  return 'maintenance';
}

// ── Version stats (deterministic, no AI, no clock) ─────────────────────────────

export interface VersionStats {
  prCount: number;
  prevTag: string | null;
  daysSincePrev: number | null;
}

/**
 * The stats-line inputs for a version: how many PRs, and how long since the
 * previous version. Pure — both dates come from VersionRecords, so this is
 * clock-free and unit-testable.
 */
export function computeStats(version: VersionRecord, prev: VersionRecord | null): VersionStats {
  const prCount = version.prNumbers.length;
  if (!prev) return { prCount, prevTag: null, daysSincePrev: null };
  const ms = new Date(version.date).getTime() - new Date(prev.date).getTime();
  const daysSincePrev = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : null;
  return { prCount, prevTag: prev.tag, daysSincePrev };
}

/**
 * A line is a usable record only if every field a renderer depends on is
 * well-typed. `version` is checked PERMISSIVELY (missing/null/string all pass):
 * records written before the field existed have no `version` key, and rejecting
 * them here would silently drop the entire pre-v2 store on first read.
 * `parseRecords` runs every accepted line through `normalizeRecord` to fill the
 * `null` default, so callers always see a well-typed `version`.
 */
export function isValidRecord(value: unknown): value is ChangelogRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const mergedAt = r['mergedAt'];
  const version = r['version'];
  return (
    typeof r['number'] === 'number' &&
    typeof r['title'] === 'string' &&
    typeof r['url'] === 'string' &&
    typeof r['author'] === 'string' &&
    typeof r['summary'] === 'string' &&
    typeof mergedAt === 'string' &&
    !Number.isNaN(new Date(mergedAt).getTime()) &&
    isCategory(r['category']) &&
    isImpact(r['impact']) &&
    typeof r['breaking'] === 'boolean' &&
    (version === undefined || version === null || typeof version === 'string')
  );
}

/**
 * Fill defaults for fields added after some records were first written, so an
 * older store loads cleanly. Currently: `version ?? null`. Applied in
 * `parseRecords` to every validated line.
 */
export function normalizeRecord(record: ChangelogRecord): ChangelogRecord {
  return { ...record, version: record.version ?? null };
}

/**
 * Parse the JSONL store. Tolerant by design: skips blank lines, **unparseable
 * JSON**, and lines that don't validate as a record — so a truncated download or
 * a hand-edited asset degrades gracefully instead of throwing and breaking the
 * writers. Any PR dropped here is re-added on the next reconcile, so the store
 * self-corrects. Pure: no I/O, so the drop is silent (the reconciler is the
 * recovery path, not a log line here).
 */
export function parseRecords(jsonl: string): ChangelogRecord[] {
  const out: ChangelogRecord[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // corrupt/partial line — skip, don't throw
    }
    if (isValidRecord(parsed)) out.push(normalizeRecord(parsed));
  }
  return out;
}

/** Serialise to JSONL, sorted by PR number ascending so the asset diff is stable. */
export function serializeRecords(records: readonly ChangelogRecord[]): string {
  return records
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((r) => JSON.stringify(r))
    .join('\n');
}

/**
 * Order two tags. Two CalVer tags compare NUMERICALLY by (y, m, d, n) so the
 * same-day suffix sorts correctly once it reaches two digits (`…11.10` after
 * `…11.2`, which a lexical compare gets wrong). A non-CalVer tag (the `v0.1.0`
 * baseline) sorts before any CalVer tag; two non-CalVer tags fall back to lexical.
 */
function compareTags(a: string, b: string): number {
  const pa = parseCalver(a);
  const pb = parseCalver(b);
  if (pa && pb) return pa.y - pb.y || pa.m - pb.m || pa.d - pb.d || pa.n - pb.n;
  if (pa && !pb) return 1; // CalVer after the non-CalVer baseline
  if (!pa && pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable order for versions: oldest first by (date, then tag). The baseline sorts first. */
function byDateThenTag(a: VersionRecord, b: VersionRecord): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return compareTags(a.tag, b.tag);
}

/** Validate one parsed `versions.json` entry. Mirrors `isValidRecord`'s strictness. */
export function isVersionRecord(value: unknown): value is VersionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const date = v['date'];
  const prNumbers = v['prNumbers'];
  return (
    typeof v['tag'] === 'string' &&
    typeof date === 'string' &&
    !Number.isNaN(new Date(date).getTime()) &&
    isTier(v['tier']) &&
    typeof v['headline'] === 'string' &&
    (v['narrative'] === null || typeof v['narrative'] === 'string') &&
    Array.isArray(prNumbers) &&
    prNumbers.every((n) => typeof n === 'number') &&
    typeof v['targetSha'] === 'string' &&
    (v['model'] === null || typeof v['model'] === 'string')
  );
}

/**
 * Parse the `versions.json` asset (a JSON array). Tolerant by design (like
 * `parseRecords`): unparseable JSON, a non-array, or a malformed entry degrades
 * to an empty/filtered result rather than throwing — the reconciler is the
 * recovery path.
 */
export function parseVersions(json: string): VersionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isVersionRecord);
}

/** Serialise versions sorted by (date, tag) ascending, pretty-printed for a readable asset. */
export function serializeVersions(versions: readonly VersionRecord[]): string {
  return JSON.stringify([...versions].sort(byDateThenTag), null, 2);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
//
// Three renderers share the pure-function contract (records in, markdown out, no
// clock/env): `renderUnreleased` (the draft body — flat, impact-tagged), the
// tier-aware `renderVersion` (one published release), and `renderBaseline` (the
// one-time history release, which keeps the legacy week→category layout). The
// model used for the disclosure line is passed in via `RenderOptions` so the
// renderers stay pure — published bodies freeze the model from versions.json;
// the draft uses the currently-configured model.

export interface RenderOptions {
  model: string | null;
}

const GENERATED_COMMENT =
  '<!-- Generated by scripts/changelog — do not edit by hand. ' +
  'Source of truth: the changelog.jsonl + versions.json assets on the unreleased draft. -->';

/** The visible "this is AI-generated" line. Names the model, or says so when there isn't one. */
export function disclosureHeader(model: string | null): string {
  const who = model ? `summaries by ${model}` : 'summaries from PR titles (no AI)';
  return `> 🤖 _Auto-generated from merged pull requests — ${who}._`;
}

/** The release title's descriptive suffix: `tag` alone, or `tag — headline`. */
export function releaseTitle(tag: string, headline: string): string {
  const h = headline.trim();
  return h ? `${tag} — ${h}` : tag;
}

const CATEGORY_RANK = new Map<Category, number>(CATEGORIES.map((c, i) => [c, i]));

/** Baseline line: keeps the legacy author-suffixed format so the frozen history reads as it did. */
function formatLine(record: ChangelogRecord): string {
  const prefix = record.breaking ? '**⚠️ Breaking:** ' : '';
  return `- ${prefix}${record.summary} ([#${record.number}](${record.url})) — @${record.author}`;
}

/** v2 line: impact-tagged, PR link kept, no author (agent-first). Used by unreleased + versions. */
function formatLineFlat(record: ChangelogRecord): string {
  const prefix = record.breaking ? '**⚠️ Breaking:** ' : '';
  return `- ${prefix}${record.summary} _[${record.impact}]_ ([#${record.number}](${record.url}))`;
}

/** A flat list with breaking changes pinned to the top, each group newest-first. */
function renderFlatList(records: readonly ChangelogRecord[]): string[] {
  const breaking = sortWithinGroup(records.filter((r) => r.breaking));
  const normal = sortWithinGroup(records.filter((r) => !r.breaking));
  return [...breaking, ...normal].map(formatLineFlat);
}

/** The "N PRs · since vPrev (X days)" context line. No contributor count (agent-first). */
function statsLine(stats: VersionStats): string {
  const prs = `${stats.prCount} PR${stats.prCount === 1 ? '' : 's'}`;
  if (stats.prevTag === null) return `_${prs} · first release_`;
  const days = stats.daysSincePrev;
  const since =
    days === null
      ? `since ${stats.prevTag}`
      : `since ${stats.prevTag} (${days} day${days === 1 ? '' : 's'})`;
  return `_${prs} · ${since}_`;
}

function renderWeek(mondayIso: string, weekRecords: readonly ChangelogRecord[]): string {
  const lines: string[] = [`### Week of ${mondayIso}`, ''];

  const breaking = weekRecords.filter((r) => r.breaking);
  const normal = weekRecords.filter((r) => !r.breaking);

  if (breaking.length > 0) {
    lines.push('**⚠️ Breaking changes**', '');
    for (const r of sortWithinGroup(breaking)) lines.push(formatLine(r));
    lines.push('');
  }

  const byCategory = new Map<Category, ChangelogRecord[]>();
  for (const r of normal) {
    const bucket = byCategory.get(r.category);
    if (bucket) bucket.push(r);
    else byCategory.set(r.category, [r]);
  }

  const orderedCategories = [...byCategory.keys()].sort(
    (a, b) => (CATEGORY_RANK.get(a) ?? 99) - (CATEGORY_RANK.get(b) ?? 99),
  );
  for (const category of orderedCategories) {
    lines.push(`**${category}**`, '');
    for (const r of sortWithinGroup(byCategory.get(category) ?? [])) lines.push(formatLine(r));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/** Stable order within a category: newest merge first, PR number desc as tiebreak. */
function sortWithinGroup(records: readonly ChangelogRecord[]): ChangelogRecord[] {
  return records.slice().sort((a, b) => {
    if (a.mergedAt !== b.mergedAt) return a.mergedAt < b.mergedAt ? 1 : -1;
    return b.number - a.number;
  });
}

const BASELINE_INTRO = [
  'A plain-English log of everything merged before per-version releases began, newest',
  'week first. Each line is one merged pull request. ⚠️ marks a breaking change.',
].join('\n');

/**
 * Render the one-time **baseline** release body: the legacy week→category layout
 * for the project's whole pre-versioning history. Frozen after the baseline is
 * cut — every change after that gets its own per-version release via
 * `renderVersion`. Deterministic (no clock, no env beyond `opts.model`), so a
 * reconcile re-render is byte-stable.
 */
export function renderBaseline(records: readonly ChangelogRecord[], opts: RenderOptions): string {
  const head = `${GENERATED_COMMENT}\n\n${disclosureHeader(opts.model)}\n\n${BASELINE_INTRO}`;
  if (records.length === 0) {
    return `${head}\n\n_No entries yet._\n`;
  }

  const byWeek = new Map<string, ChangelogRecord[]>();
  for (const r of records) {
    const week = isoWeekMonday(r.mergedAt);
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(r);
    else byWeek.set(week, [r]);
  }

  const weeksNewestFirst = [...byWeek.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const sections = weeksNewestFirst.map((week) => renderWeek(week, byWeek.get(week) ?? []));

  return `${head}\n\n${sections.join('\n\n')}\n`;
}

/**
 * Render the **unreleased draft** body: a flat, impact-tagged list of everything
 * merged but not yet shipped (records with `version === null`). Filters
 * defensively so a caller passing the full store still renders only the pending
 * slice. Breaking changes pinned to the top. Deterministic.
 */
export function renderUnreleased(records: readonly ChangelogRecord[], opts: RenderOptions): string {
  const head = `${GENERATED_COMMENT}\n\n${disclosureHeader(opts.model)}\n\n## Unreleased`;
  const pending = records.filter((r) => r.version === null);
  if (pending.length === 0) {
    return `${head}\n\n_Nothing pending — everything merged so far has shipped._\n`;
  }
  const intro = '_Merged but not yet shipped. These land in the next version cut on deploy._';
  return `${head}\n\n${intro}\n\n${renderFlatList(pending).join('\n')}\n`;
}

/**
 * Render one **published version** release body, tier-aware. The descriptive
 * headline lives in the release TITLE (see `releaseTitle`), so the body is:
 * disclosure → narrative (Notable only) → stats line → flat impact-tagged list
 * (breaking pinned). `records` must already be filtered to this version; `stats`
 * is precomputed (pure). Maintenance and Standard differ only in the title — the
 * body shape is the same; Notable adds the narrative paragraph.
 */
export function renderVersion(
  version: VersionRecord,
  records: readonly ChangelogRecord[],
  stats: VersionStats,
  opts: RenderOptions,
): string {
  const parts: string[] = [GENERATED_COMMENT, disclosureHeader(opts.model)];
  if (version.narrative && version.narrative.trim() !== '') {
    parts.push(version.narrative.trim());
  }
  parts.push(statsLine(stats));
  const lines = renderFlatList(records);
  parts.push(lines.length > 0 ? lines.join('\n') : '_No changelog-visible changes._');
  return `${parts.join('\n\n')}\n`;
}

// ── Cutting a version (pure assembly; I/O lives in release.ts) ─────────────────

/** Records not yet assigned to any version. Empty ⇒ release.ts skips the cut. Pure. */
export function unreleasedRecords(records: readonly ChangelogRecord[]): ChangelogRecord[] {
  return records.filter((r) => r.version === null);
}

/** Stamp `version: tag` onto exactly the records in `prNumbers`. Pure (new array). */
export function stampVersion(
  records: readonly ChangelogRecord[],
  prNumbers: readonly number[],
  tag: string,
): ChangelogRecord[] {
  const set = new Set(prNumbers);
  return records.map((r) => (set.has(r.number) ? { ...r, version: tag } : r));
}

export interface CutArtifacts {
  versionRecord: VersionRecord;
  title: string;
  body: string;
}

/**
 * Assemble the VersionRecord + rendered title/body for one cut. Pure given the
 * narrative/date/sha, so the same inputs always produce the same release — which is
 * what lets `release.ts` recompute cleanly on a same-day tag collision and what the
 * reconciler relies on to re-render byte-stably.
 *
 * `model` is the DISCLOSURE model — whether the per-PR summaries were AI-written
 * (key availability at cut time) — and is what the body's "summaries by …" line
 * reflects. It is deliberately NOT `vn.model` (the version-prose model), which is
 * null on a maintenance cut even though that release's bullets may be Claude-written
 * by the per-merge hook. Frozen on the record so reconcile re-renders the same line.
 */
export function buildCut(
  tag: string,
  tier: ComputedTier,
  vn: VersionNarrative,
  unreleased: readonly ChangelogRecord[],
  releaseDate: Date,
  headSha: string,
  versions: readonly VersionRecord[],
  model: string | null,
): CutArtifacts {
  const versionRecord: VersionRecord = {
    tag,
    date: releaseDate.toISOString(),
    tier,
    headline: vn.headline,
    narrative: vn.narrative,
    prNumbers: unreleased
      .map((r) => r.number)
      .slice()
      .sort((a, b) => a - b),
    targetSha: headSha,
    model,
  };
  const stats = computeStats(versionRecord, previousVersion(versions, tag));
  const body = renderVersion(versionRecord, unreleased, stats, { model });
  return { versionRecord, title: releaseTitle(tag, vn.headline), body };
}
