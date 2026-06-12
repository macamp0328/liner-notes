---
name: issue
description: Work a GitHub issue end-to-end — fetch it, plan the approach, get approval, implement, and open a PR. Use when the user shares a GitHub issue URL (e.g. https://github.com/macamp0328/liner-notes/issues/47) or says things like "work on issue #N", "implement issue 78", or "tackle this issue".
disable-model-invocation: true
tools: Bash, Read, Edit, Write, Glob, Grep
---

# Work a GitHub Issue

Fetch the issue, orient in the codebase, present a plan for approval, implement, and open a PR — owning every git operation from branch creation through to the PR description.

**Issue:** $ARGUMENTS

## Live Context

- Current branch: !`git branch --show-current`
- Git status: !`git status --short`

---

## Phase 1 — Fetch and understand the issue

```bash
# Parse the issue number and repo from $ARGUMENTS.
# $ARGUMENTS may be a full URL (https://github.com/owner/repo/issues/N),
# a bare number (47), or a #-prefixed number (#47).

# For a URL:
gh issue view "$ARGUMENTS" --json number,title,body,labels,comments

# For a bare number (default repo):
gh issue view 47 --repo macamp0328/liner-notes --json number,title,body,labels,comments
```

Read the full `body` and every entry in `comments`. Acceptance criteria, design decisions, and constraints are frequently added in comments after the initial description — don't stop at the body.

From this, establish:

- **What is being asked for** (1-2 sentences in your own words)
- **Issue type** — infer from labels or content: `feat`, `fix`, `chore`, `docs`, `refactor`, etc. Use it as an optional commit prefix when helpful.
- **Which service is affected** — almost always `graph-service`
- **Labels** — if the issue is missing an `area:*`, type, status, or `priority:*` label, apply the right ones now (see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md)). You're about to work it, so its metadata should be correct for the backlog queries.

---

## Phase 2 — Orient in the codebase

Read context before touching any file:

1. **Repo-level `CLAUDE.md`** — architecture overview, non-obvious decisions, and cross-cutting conventions
2. **Service-level `CLAUDE.md`** (e.g. `services/graph-service/CLAUDE.md`) — local conventions, tech choices, and known footguns
3. **Relevant source files** — use `grep`/`find` to locate the code the issue touches

Pay special attention to the "Non-Obvious Decisions" sections in both CLAUDE.md files — they document constraints that directly affect how a solution should be shaped.

---

## Phase 3 — Plan (enter plan mode)

Call `ExitPlanMode` to surface a plan before creating any branch or writing any code. The plan must cover:

- **What the issue asks for** (your 1-2 sentence summary)
- **Files to create or modify**, and why each one
- **Any risks, ambiguities, or non-obvious decisions**
- **Proposed branch name**: `task/{N}-{2-4-word-kebab-description}`
- **Commit type**: e.g. `feat`, `fix`, `refactor`

Wait for the user to approve. If they push back or ask for changes, revise and re-present — don't begin implementation until you have explicit approval.

---

## Phase 4 — Create the task branch

```bash
git fetch origin
git checkout -b task/<N>-<short-description> origin/main
```

Always branch off `origin/main`, never off whichever branch happens to be checked out.

---

## Phase 5 — Implement

Work incrementally. For non-trivial changes, break the work into logical commits (one per coherent unit of change) rather than one giant commit at the end.

For each unit:

1. Make the change
2. Run the pre-commit chain (Phase 6)
3. Commit if the chain is green

If the issue is ambiguous, implement the most conservative interpretation that satisfies the stated requirements. Don't add features, refactor surrounding code, or gold-plate beyond scope.

If you add new code paths, write unit tests. The repo enforces coverage thresholds — new uncovered code will fail CI.

---

## Phase 6 — Pre-commit validation chain

Run in order before every commit. Stop and fix if anything fails — do not commit broken code.

```bash
# 1. Format (--write fixes in place; run first so subsequent checks see clean files)
pnpm --filter graph-service exec prettier --write .

# 2. Lint
pnpm --filter graph-service lint

# 3. Type-check
pnpm --filter graph-service typecheck

# 4. Unit tests + coverage (final gate — thresholds are enforced)
pnpm --filter graph-service test:unit:coverage
```

---

## Phase 7 — Commit

Commit message format is not enforced. Prefer clear, concise messages; starting the subject with a lowercase letter is still recommended for consistency.

```
<type>(<optional-scope>): <lowercase subject>

<optional body — explain the why, not the what>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Valid types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `style`, `build`, `revert`

**Wrong:** `feat: Add retry logic for Wikidata`
**Right:** `feat: add retry logic for Wikidata`

Mid-word capitals are fine (`feat: add openAPI schema`). Only the first character must be lowercase.

Always stage specific files — never `git add -A` or `git add .`.

---

## Phase 8 — Push and open the PR

```bash
git push -u origin task/<N>-<short-description>

gh pr create \
  --title "task/<N>: <lowercase description>" \
  --body "$(cat <<'EOF'
## Summary

<1-3 bullet points — what changed and why>

## Implementation notes

<non-obvious decisions, trade-offs, or anything the reviewer should know>

## Test plan

- [ ] Unit tests pass (`pnpm --filter graph-service test:unit`)
- [ ] Coverage thresholds met (`pnpm --filter graph-service test:unit:coverage`)
- [ ] <any manual verification steps specific to this change>

Closes #<N>

🤖 Generated with [Claude Code](https://claude.ai/claude-code)
EOF
)"
```

`Closes #<N>` auto-links the PR to the issue and closes it on merge. Always include it.

Opening the PR is **not** the end — continue to Phase 9. Don't stop and wait to be told.

---

## Phase 9 — Shepherd the PR to merge-ready

The PR is open, which kicks off Copilot's review and the first CI run. Now drive it to merge-ready **automatically** — don't hand control back to wait for the user to send `/tend-to-pr` or click "Update branch".

Run the `/shepherd-pr` workflow for the PR you just opened (invoke the skill directly; if it can't be invoked from here, read `.claude/skills/shepherd-pr/SKILL.md` and follow its phases for this PR). It will:

1. Wait for the first CI run and Copilot's review (typically a few minutes, ~7 min cap; via a background poll — it yields rather than blocking on the user).
2. Auto-run `/tend-to-pr` if there are any failing checks or review comments.
3. Bring the branch up to date with `main` (the agent does the "Update branch" merge and resolves routine conflicts itself).
4. Send a push notification when the PR is green and current.

It **never merges** — that stays the user's call. Hand off as soon as the PR is open.

---

## Guardrails

- **Never** push directly to `main` — always via a PR
- **Never** `git add -A` or `git add .` — stage specific files only
- **Never** skip the pre-commit chain (`prettier` → `lint` → `typecheck` → `test:unit:coverage`)
- **Never** use `--no-verify` to bypass hooks
- **Never** start implementing before the plan is approved
- **After opening the PR**, hand off to `/shepherd-pr` automatically (Phase 9) — don't end the turn waiting for the user to ask
- **Stop and ask** if the issue scope turns out to be significantly larger or different than what was planned
- **ESM imports:** all local/relative imports require `.js` extensions (`import { foo } from './bar.js'`)
- **No `any`** without an inline justification comment
- **No comments** unless the _why_ is non-obvious — well-named identifiers explain the what
- **Explicit return types** on all exported functions
