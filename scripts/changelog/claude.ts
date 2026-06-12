// Claude summarisation: turn a merged PR into a validated ChangelogRecord.
//
// Quality comes from structured outputs — Claude returns a schema-validated
// object {category, summary, impact, breaking}, not free text we hope is one
// sentence. The model reads what actually changed (title + body + labels +
// diffstat), and the editorial voice lives in the committed style.md so tuning
// the changelog is a one-file PR.
//
// AI-enhanced, not AI-required: with no ANTHROPIC_API_KEY (forks), or on any API
// error, we fall back to a cleaned PR title so the merge path never fails.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Category,
  type ChangelogRecord,
  type ComputedTier,
  type Impact,
  type SummarySource,
  type VersionNarrative,
  CATEGORIES,
  IMPACTS,
  isCategory,
  isImpact,
} from './lib.js';

/** Everything the summariser needs about one PR (gathered by store.ts via `gh`). */
export interface PrInput {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  mergedAt: string;
  labels: string[];
  /** Pre-rendered "path  +A -D" diffstat lines (size-capped by the caller). */
  filesSummary: string;
}

export interface SummarizeOutcome {
  record: ChangelogRecord;
  /** Human note for logs / the GitHub step summary (model + token cost, or fallback reason). */
  note: string;
}

const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_OUTPUT_TOKENS = 300;
const MAX_BODY_CHARS = 4000;
/** Headroom for the (rare) two-sentence summary; the schema still wants it terse. */
const MAX_SUMMARY_CHARS = 320;
/** Version-level prose (headline + optional 2–3 sentence narrative) needs more room. */
const VERSION_MAX_OUTPUT_TOKENS = 400;
const MAX_HEADLINE_CHARS = 100;
const MAX_NARRATIVE_CHARS = 600;

// Per-MTok USD (Opus 4.8). Only used to print an informational cost note.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    summary: { type: 'string' },
    impact: { type: 'string', enum: [...IMPACTS] },
    breaking: { type: 'boolean' },
  },
  required: ['category', 'summary', 'impact', 'breaking'],
} as const;

export function currentModel(): string {
  return process.env['CHANGELOG_MODEL']?.trim() || DEFAULT_MODEL;
}

/**
 * The model to name in a disclosure line: the configured model when a key is set,
 * else `null` so the disclosure honestly reads "no AI". Without a key every summary
 * is a PR-title fallback, so naming a model would be a lie. Use this (not
 * `currentModel()`) for any draft/baseline render's disclosure.
 */
export function disclosureModel(): string | null {
  return hasApiKey() ? currentModel() : null;
}

export function hasApiKey(): boolean {
  return (process.env['ANTHROPIC_API_KEY']?.trim().length ?? 0) > 0;
}

function styleText(): string {
  return readFileSync(join(import.meta.dirname, 'style.md'), 'utf8');
}

export function buildUserPrompt(pr: PrInput): string {
  return [
    `PR #${pr.number}: ${pr.title}`,
    `Author: @${pr.author}`,
    `Labels: ${pr.labels.length > 0 ? pr.labels.join(', ') : '(none)'}`,
    '',
    'Files changed:',
    pr.filesSummary.trim() || '(not available)',
    '',
    'Description:',
    pr.body.trim().slice(0, MAX_BODY_CHARS) || '(no description)',
  ].join('\n');
}

export interface ParsedSummary {
  category: Category;
  summary: string;
  impact: Impact;
  breaking: boolean;
}

/**
 * Parse + coerce the model's JSON. Structured outputs guarantee the shape, but we
 * never trust it blindly: malformed JSON or a non-object returns `null` (never
 * throws), and each field is coerced to a safe default so an odd value can't
 * produce a broken record. Returning null (vs throwing) is what keeps one bad
 * response from killing an entire batch — see `recordFromText`.
 */
export function parseSummary(text: string): ParsedSummary | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const category = isCategory(obj['category']) ? obj['category'] : 'Changed';
  const impact = isImpact(obj['impact']) ? obj['impact'] : 'developer';
  const summary =
    typeof obj['summary'] === 'string' ? obj['summary'].trim().slice(0, MAX_SUMMARY_CHARS) : '';
  const breaking = obj['breaking'] === true;
  return { category, summary, impact, breaking };
}

/**
 * Build a record from a model response's text, falling back to the PR title when
 * the JSON is malformed OR the summary came back empty. Guarantees we never emit
 * a blank/broken changelog line, and never throw — so one unusable response in a
 * batch degrades to that PR's fallback instead of losing the whole run.
 */
export function recordFromText(pr: PrInput, text: string): ChangelogRecord {
  const parsed = parseSummary(text);
  if (parsed === null || parsed.summary === '') return fallbackRecord(pr);
  return toRecord(pr, parsed, 'claude');
}

function toRecord(pr: PrInput, parsed: ParsedSummary, source: SummarySource): ChangelogRecord {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    mergedAt: pr.mergedAt,
    category: parsed.category,
    summary: parsed.summary,
    impact: parsed.impact,
    breaking: parsed.breaking,
    summarySource: source,
    version: null,
  };
}

// ── Fallback (no API key, or API error) ────────────────────────────────────

// Anchored, no nested quantifiers (`[^)]*` is linear, the scope group is
// optional-not-repeated); runs on a bounded PR title. safe-regex false-positives
// on the digit/alternation.
const CONVENTIONAL_PREFIX =
  // eslint-disable-next-line security/detect-unsafe-regex
  /^(task\/\d+|feat|fix|chore|docs|build|ci|refactor|perf|style|test)(\([^)]*\))?!?:\s*/i;

export function cleanTitle(title: string): string {
  const stripped = title.replace(CONVENTIONAL_PREFIX, '').trim();
  const base = stripped || title.trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function fallbackCategory(title: string): Category {
  const lead = title.toLowerCase();
  if (lead.startsWith('fix')) return 'Fixed';
  if (lead.startsWith('docs')) return 'Docs';
  if (/^(chore|build|ci)/.test(lead)) return 'Infra';
  if (/^(feat|add)/.test(lead)) return 'Added';
  return 'Changed';
}

export function fallbackRecord(pr: PrInput): ChangelogRecord {
  return toRecord(
    pr,
    {
      category: fallbackCategory(pr.title),
      summary: cleanTitle(pr.title),
      impact: 'developer',
      breaking: false,
    },
    'fallback',
  );
}

// ── Single summarisation (fast path) ────────────────────────────────────────

function findText(content: Anthropic.Messages.ContentBlock[]): string {
  for (const block of content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

function costNote(usage: Anthropic.Messages.Usage, modelId: string, discount = 1): string {
  const price = PRICING[modelId];
  const cost = price
    ? ((usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000) *
      discount
    : 0;
  return `Claude (${modelId}): in=${usage.input_tokens} out=${usage.output_tokens} tok ≈ $${cost.toFixed(4)}`;
}

/** Summarise one PR, falling back to the cleaned title if Claude is unavailable. */
export async function summarize(pr: PrInput): Promise<SummarizeOutcome> {
  if (!hasApiKey()) {
    return { record: fallbackRecord(pr), note: 'fallback (no ANTHROPIC_API_KEY)' };
  }
  try {
    const client = new Anthropic();
    const modelId = currentModel();
    const message = await client.messages.create({
      model: modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: styleText(),
      messages: [{ role: 'user', content: buildUserPrompt(pr) }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    });
    const record = recordFromText(pr, findText(message.content));
    const cost = costNote(message.usage, modelId);
    const note =
      record.summarySource === 'claude' ? cost : `fallback (unusable response) — ${cost}`;
    return { record, note };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { record: fallbackRecord(pr), note: `fallback (Claude error: ${reason})` };
  }
}

// ── Batched summarisation (one-shot historical backfill) ────────────────────

const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_ATTEMPTS = 360; // 360 * 10s = 60 min ceiling

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Summarise many PRs in one Message Batch (50% cheaper, non-latency-sensitive) —
 * used to seed the changelog with the project's entire merged history. With no
 * API key, every PR degrades to its fallback record. PRs that error/expire in the
 * batch also fall back, so backfill always returns one record per input.
 */
export async function summarizeBatch(prs: PrInput[]): Promise<ChangelogRecord[]> {
  if (prs.length === 0) return [];
  if (!hasApiKey()) {
    console.log('No ANTHROPIC_API_KEY — backfilling with fallback (PR-title) summaries.');
    return prs.map(fallbackRecord);
  }

  const client = new Anthropic();
  const modelId = currentModel();
  const byId = new Map(prs.map((pr) => [`pr-${pr.number}`, pr]));
  const system = styleText();

  const batch = await client.messages.batches.create({
    requests: prs.map((pr) => ({
      custom_id: `pr-${pr.number}`,
      params: {
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: 'user', content: buildUserPrompt(pr) }],
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
      },
    })),
  });
  console.log(`Submitted batch ${batch.id} (${prs.length} PRs). Polling…`);

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const status = await client.messages.batches.retrieve(batch.id);
    if (status.processing_status === 'ended') break;
    const c = status.request_counts;
    console.log(
      `  ${status.processing_status}: processing=${c.processing} succeeded=${c.succeeded} errored=${c.errored}`,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  const records = new Map<number, ChangelogRecord>();
  for await (const item of await client.messages.batches.results(batch.id)) {
    const pr = byId.get(item.custom_id);
    if (!pr) continue;
    if (item.result.type === 'succeeded') {
      // recordFromText never throws — a single unparseable response degrades to
      // that PR's fallback instead of aborting the whole batch write.
      records.set(pr.number, recordFromText(pr, findText(item.result.message.content)));
    } else {
      console.warn(`  ${item.custom_id}: ${item.result.type} — using fallback`);
      records.set(pr.number, fallbackRecord(pr));
    }
  }

  // Any PR with no result at all (shouldn't happen) still gets a record.
  return prs.map((pr) => records.get(pr.number) ?? fallbackRecord(pr));
}

// ── Version-level prose (headline + narrative, one call per cut release) ──────
//
// A cut release gets ONE combined call: a short headline (the release title's
// descriptive suffix) and — for Notable releases only — a 2–3 sentence narrative.
// Standard releases keep just the headline; Maintenance releases skip the call
// entirely (release.ts uses the deterministic fallback). The editorial voice lives
// in version-style.md, separate from the per-PR style.md.

const VERSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    narrative: { type: 'string' },
  },
  required: ['headline'],
} as const;

function versionStyleText(): string {
  return readFileSync(join(import.meta.dirname, 'version-style.md'), 'utf8');
}

export interface VersionSummaryInput {
  tag: string;
  tier: ComputedTier;
  records: ChangelogRecord[];
  prevTag: string | null;
}

/**
 * Deterministic title + null narrative — used for Maintenance, no key, or any error.
 * The headline carries no tag prefix; `releaseTitle` composes `${tag} — ${headline}`.
 */
export function fallbackVersionNarrative(count: number): VersionNarrative {
  return { headline: `${count} change${count === 1 ? '' : 's'}`, narrative: null, model: null };
}

/** Compose the version prompt from the slice of records. Pure → unit-testable. */
export function buildVersionPrompt(input: VersionSummaryInput): string {
  const lines = input.records.map((r) => {
    const flags = [r.category, r.impact, r.breaking ? 'breaking' : null].filter(Boolean).join(', ');
    return `- ${r.summary} (${flags})`;
  });
  return [
    `Version: ${input.tag}`,
    `Tier: ${input.tier}`,
    input.prevTag ? `Previous version: ${input.prevTag}` : 'This is the first version.',
    '',
    `Changes in this version (${input.records.length}):`,
    ...lines,
    '',
    input.tier === 'notable'
      ? 'Write a headline AND a 2–3 sentence narrative.'
      : 'Write a headline only — no narrative.',
  ].join('\n');
}

/**
 * Parse the model's JSON. Structured outputs guarantee the shape, but we never
 * trust it blindly: malformed JSON, a non-object, or an empty headline returns
 * `null` (caller falls back). Headline/narrative are length-capped defensively.
 */
export function parseVersionNarrative(
  text: string,
): { headline: string; narrative: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const headline =
    typeof obj['headline'] === 'string' ? obj['headline'].trim().slice(0, MAX_HEADLINE_CHARS) : '';
  if (headline === '') return null;
  const narrativeRaw = typeof obj['narrative'] === 'string' ? obj['narrative'].trim() : '';
  const narrative = narrativeRaw === '' ? null : narrativeRaw.slice(0, MAX_NARRATIVE_CHARS);
  return { headline, narrative };
}

/**
 * Headline (+ narrative for Notable) for one version. Never throws: no key or any
 * API/parse error degrades to `fallbackVersionNarrative`. A narrative produced for a
 * non-Notable tier is discarded, so tier is the single gate on narrative prose.
 */
export async function summarizeVersion(input: VersionSummaryInput): Promise<VersionNarrative> {
  const fallback = fallbackVersionNarrative(input.records.length);
  if (!hasApiKey()) return fallback;
  try {
    const client = new Anthropic();
    const modelId = currentModel();
    const message = await client.messages.create({
      model: modelId,
      max_tokens: VERSION_MAX_OUTPUT_TOKENS,
      system: versionStyleText(),
      messages: [{ role: 'user', content: buildVersionPrompt(input) }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: VERSION_SCHEMA } },
    });
    const parsed = parseVersionNarrative(findText(message.content));
    if (parsed === null) return fallback;
    const narrative = input.tier === 'notable' ? parsed.narrative : null;
    return { headline: parsed.headline, narrative, model: modelId };
  } catch {
    return fallback;
  }
}
