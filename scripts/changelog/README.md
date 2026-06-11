# Changelog — plain-English, self-healing, changelog-as-data

A small system that keeps a **rolling draft GitHub Release** current with a one-sentence,
plain-English summary of every merged PR — grouped by week, categorised, with breaking
changes pinned to the top. Open the repo's **Releases** tab to read it.

It is built around one idea: **a changelog is data, not prose.** There is a single
structured store keyed by PR number; everything human-facing is a deterministic _render_
of it. That buys idempotency, self-healing, machine-queryability, and a trivial historical
backfill — properties a string-appending bot can't have.

## Architecture

```
                 ┌──────────────── changelog.jsonl ────────────────┐
                 │  one record per PR, keyed by number (idempotent)│
   PR #283 ─┐    │  { number, title, mergedAt, author, url,        │
            ├──► │    category, summary, impact, breaking }         │ ──► render() ──► draft release body
   weekly ──┘    └──────────────────────────────────────────────────┘     (week → ⚠️ breaking → category)
   reconcile        stored as a release ASSET on the `unreleased` draft
```

- **Store** — `changelog.jsonl`, attached as an **asset** on the `unreleased` draft release.
  A draft release is associated with a tag _name_ but **does not create the git tag ref until
  it's published**, so this rolling draft never tags or commits to `main`. (GitHub still shows
  auto-generated "Source code" archives for the draft's target commit — those are a GitHub
  artifact, not part of the changelog; readers consume the body and the `changelog.jsonl`
  asset.) Keyed by PR number ⇒ every write is idempotent.
- **Render** ([`lib.ts`](lib.ts) `render()`) — a pure function `records → markdown`. The
  release body is _always_ a full re-render of the store; we never hand-edit it.
- **Writer 1 — fast path** ([`update.ts`](update.ts), [`changelog.yml`](../../.github/workflows/changelog.yml)):
  on every squash-merge to `main`, summarise the PR and upsert one record.
- **Writer 2 — reconciler** ([`reconcile.ts`](reconcile.ts), [`changelog-reconcile.yml`](../../.github/workflows/changelog-reconcile.yml)):
  weekly, diff merged PRs against the store and fill any gaps the fast path missed. The
  store is derived, so it can always be rebuilt — the release-world analog of the repo's
  fail-on-drift guards.
- **Backfill** ([`backfill.ts`](backfill.ts)): summarise the whole merged history in one
  **Message Batch** (50% cheaper) to seed the store on day one.

## AI quality

Each PR is summarised with **structured outputs** ([`claude.ts`](claude.ts)) — Claude returns
a schema-validated `{ category, summary, impact, breaking }`, reading the PR title, body,
labels, and diffstat. The editorial voice is the committed system prompt in
[`style.md`](style.md) — tuning the changelog is a one-file PR.

**AI-enhanced, not AI-required:** with no `ANTHROPIC_API_KEY`, or on any API error, the
writer falls back to a cleaned PR title (`summarySource: "fallback"`) — the merge path never
fails.

## Files

| File           | Role                                                          |
| -------------- | ------------------------------------------------------------- |
| `lib.ts`       | Pure core: parse / week / upsert / **render**. Unit-tested.   |
| `lib.test.ts`  | `node:test` unit tests (`pnpm changelog:test`).               |
| `claude.ts`    | Structured-output `summarize()` + batched `summarizeBatch()`. |
| `store.ts`     | All `gh` I/O: PR fetch, release asset read/write.             |
| `update.ts`    | Fast-path entry (`PR_NUMBER`).                                |
| `reconcile.ts` | Reconciler entry (`--since`).                                 |
| `backfill.ts`  | One-shot historical seed.                                     |
| `style.md`     | The summariser's system prompt (editorial voice).             |

## Commands

```bash
pnpm changelog:test                               # unit tests
pnpm changelog:update 304                         # summarise one PR (also refreshes that entry)
DRY_RUN=1 pnpm changelog:update 304               # ...preview only, no writes
pnpm changelog:backfill                           # seed the store (run once after setup)
pnpm changelog:backfill --refresh                 # re-summarise EVERY entry (e.g. after editing style.md)
pnpm changelog:reconcile --since 2026-06-01       # heal a window on demand
```

`DRY_RUN=1` prints the record + rendered body and writes nothing. All commands need `gh`
auth (or `GH_TOKEN`); Claude summaries need `ANTHROPIC_API_KEY` (else they fall back to the PR
title).

**Local env:** the scripts auto-load `.env.local` then `.env` from the repo root (via
[`env.ts`](env.ts)), so a key in either file is picked up without a manual `export` — a real
environment variable (CI secret) still wins. Both files are gitignored.

**Upgrading fallbacks:** backfill and reconcile automatically re-summarise existing PR-title
**fallback** entries once a key is available — so if the history was seeded before the key was
set, just re-run `pnpm changelog:backfill` and the title-only entries become Claude summaries
(no need to delete the draft). `--refresh` forces re-summarising entries that are already
Claude-written too.

## Setup (one-time)

```bash
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>   # enables Claude summaries in CI
# put ANTHROPIC_API_KEY in .env.local (gitignored) for local runs, then:
pnpm changelog:backfill                                 # seed the project's history
```

## Forking / tuning

- **Cheaper model:** set `CHANGELOG_MODEL=claude-haiku-4-5` (in the workflow `env`, or your
  shell). Default is `claude-opus-4-8`.
- **Voice:** edit [`style.md`](style.md), then `pnpm changelog:backfill --refresh` to re-render history in the new voice.
- **Prefer a committed file over a release asset?** `store.ts` is the only place that knows
  where the store lives — swap `readStore`/`writeStore` to read/write a committed
  `CHANGELOG.md` + `.jsonl` instead of the release. (Note: writing to a protected `main`
  from CI needs a branch-protection bypass — the release-asset design avoids that.)
