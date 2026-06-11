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

/** A line is a usable record only if every field `render()` depends on is well-typed. */
export function isValidRecord(value: unknown): value is ChangelogRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const mergedAt = r['mergedAt'];
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
    typeof r['breaking'] === 'boolean'
  );
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
    if (isValidRecord(parsed)) out.push(parsed);
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

const CATEGORY_RANK = new Map<Category, number>(CATEGORIES.map((c, i) => [c, i]));

function formatLine(record: ChangelogRecord): string {
  const prefix = record.breaking ? '**⚠️ Breaking:** ' : '';
  return `- ${prefix}${record.summary} ([#${record.number}](${record.url})) — @${record.author}`;
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

const PREAMBLE = [
  '<!-- Generated by scripts/changelog — do not edit by hand. -->',
  '<!-- Source of truth: the changelog.jsonl asset on this release. -->',
  '',
  "A plain-English log of what's changed, newest week first. Each line is one merged",
  'pull request, summarised for someone exploring the project. ⚠️ marks a breaking change.',
].join('\n');

/**
 * Render the full release body from the record set. Deterministic: a pure
 * function of `records` (no clock, no env), so an unchanged store renders an
 * unchanged body — the reconciler only rewrites when something actually changed.
 * Newest ISO-week first; within a week, breaking changes are pinned to the top,
 * then categories in canonical order.
 */
export function render(records: readonly ChangelogRecord[]): string {
  if (records.length === 0) {
    return `${PREAMBLE}\n\n_No entries yet._\n`;
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

  return `${PREAMBLE}\n\n${sections.join('\n\n')}\n`;
}
