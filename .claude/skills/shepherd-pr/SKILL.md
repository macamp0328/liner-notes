---
name: shepherd-pr
description: Drive an open PR to merge-ready autonomously — wait for first-pass CI + Copilot review, auto-run /tend-to-pr for any failures or comments, bring the branch up to date with main, and notify when it's green + current. Never merges. Use right after opening a PR (e.g. handed off from /issue), or standalone on any open PR.
disable-model-invocation: true
tools: Bash, Read, Edit, Write, Glob, Grep
---

# Shepherd a PR to merge-ready

Take a freshly-opened PR all the way to "ready for the human to merge" **without stopping to be told**. Wait for the first-pass CI run and Copilot's automated review, auto-run `/tend-to-pr` for anything that needs fixing or answering, bring the branch up to date with `main`, and finish with a push notification. The human reviews and merges — this skill never does.

**The point of this skill is to eliminate human-gated hangs.** Every action it takes (running `/tend-to-pr`, updating the branch, resolving conflicts) is one a person would otherwise do by hand. Do them automatically. Only pause for genuine judgment (see Guardrails).

If a PR number is provided as an argument, use that. Otherwise default to the PR for the current branch.

**PR to shepherd:** $ARGUMENTS

## Live Context

- Current branch: !`git branch --show-current`
- PR status (current branch): !`gh pr view --json number,title,state,statusCheckRollup 2>/dev/null || echo "No open PR found for this branch"`

---

## Phase 0 — Resolve the PR

```bash
# Normalize any form ($ARGUMENTS may be a number, #number, or URL); fall back to the current branch's PR.
if [ -n "$ARGUMENTS" ]; then
  pr_number="$(gh pr view "$ARGUMENTS" --json number --jq '.number')"
else
  pr_number="$(gh pr view --json number --jq '.number')"
fi
gh pr view "$pr_number" --json number,title,headRefName,baseRefName,state

# Make sure the working tree is ON the PR's head branch before the loop runs —
# Phase C does `git merge`/`git push`, so a standalone invocation from a different
# branch must switch first. (Handed off from /issue you're already on it: no-op.)
head_branch="$(gh pr view "$pr_number" --json headRefName --jq '.headRefName')"
if [ "$(git branch --show-current)" != "$head_branch" ]; then
  gh pr checkout "$pr_number"   # switch to the head branch; commit/stash local work first
fi
```

Hold onto `pr_number` and `head_branch` for the rest of the run.

Then run the **shepherd loop** below: **Phase A → B → C**, repeating for up to **3 rounds**. Stop early (jump to Phase E) the moment the branch is up to date with `main` **and** CI is green. `main`'s ruleset does **not** require branches to be up to date before merging (no strict status-check policy), so being a little behind never blocks a merge — exhausting the 3 rounds is a fine outcome, not a failure.

---

## Phase A — Wait for CI + Copilot (non-blocking)

Wait for the first CI run to settle and Copilot's review to land. Foreground `sleep` is blocked, so run this as a **background** command (Bash tool `run_in_background: true`). It exits when the condition is met or after ~7 minutes, and the harness re-invokes you when it exits — you are not blocking on the human, you're yielding until the machines are done.

```bash
PR="$pr_number"
deadline=$(( $(date +%s) + 420 ))   # ~7 min cap
while :; do
  pending=$(gh pr checks "$PR" --json bucket --jq '[.[] | select(.bucket=="pending")] | length' 2>/dev/null || echo 1)
  copilot=$(gh api --paginate repos/{owner}/{repo}/pulls/"$PR"/reviews \
    --jq '.[] | select(.user.login | test("copilot"; "i")) | .id' 2>/dev/null | wc -l | tr -d ' ')
  { [ "$pending" = 0 ] && [ "$copilot" != 0 ]; } && break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 30
done
echo "wait complete: pending=$pending copilot_reviews=$copilot"
```

Notes:

- `gh api` substitutes `{owner}`/`{repo}` from the current repo automatically.
- `2>/dev/null || echo 1` tolerates the race where no checks are registered yet (treated as still-pending).
- The `copilot` match is a case-insensitive substring, covering `Copilot`, `copilot-pull-request-reviewer[bot]`, `github-copilot[bot]`, etc. The fetch uses `--paginate` and counts lines (not `| length`, which would print a per-page count) so a Copilot review isn't missed on a PR with many reviews.
- If Copilot is not configured for this PR it simply never appears, the ~7-min cap fires, and you proceed.
- **Rounds 2+** (after a Phase C push) don't need to wait for Copilot again — a plain `gh pr checks "$pr_number" --watch` is enough to wait for the new CI run.

---

## Phase B — Auto-tend if there's anything to address

Read the settled state:

```bash
# Failing checks?
gh pr checks "$pr_number" --json name,bucket --jq '[.[] | select(.bucket=="fail")]'

# Inline review comments (Copilot or human)?
gh api repos/{owner}/{repo}/pulls/"$pr_number"/comments \
  --paginate --jq '[.[] | {user: .user.login, path, line, body}]'

# Reviews left (Copilot or human), with state?
gh pr view "$pr_number" --json reviews \
  --jq '[.reviews[] | {author: .author.login, state, body}]'
```

**Run `/tend-to-pr` if EITHER** of these holds:

- any check has `bucket == "fail"`, **or**
- there are unresolved review comments — any inline comment, or a review whose `state` is `CHANGES_REQUESTED`/`COMMENTED` with a non-empty body.

A bare Copilot **approval with no comments** is not a trigger.

To run it, invoke the `/tend-to-pr` skill for this PR and let it finish before continuing:

> Run the `/tend-to-pr` workflow for PR #`$pr_number`. Invoke the skill directly; if it can't be invoked from here, read `.claude/skills/tend-to-pr/SKILL.md` and follow its phases for this PR.

`/tend-to-pr` already does the hard part: it fixes CI (its own bounded 3-cycle loop), replies to every comment (fix or decline), and — by design — **pauses only when it needs to decline a _human_ reviewer's comment**. That pause is correct; let it ask. Bot/Copilot comments are handled autonomously.

If nothing needs tending, skip straight to Phase C.

---

## Phase C — Bring the branch up to date with `main`

This is the step that replaces the manual **"Update branch"** click. Do it **after** tending so the branch isn't immediately stale again.

```bash
git fetch origin
if [ "$(git rev-list --count HEAD..origin/main)" -gt 0 ]; then
  git merge --no-edit origin/main
  git push
fi
```

- **Merge, not rebase.** The branch is already pushed and may carry commits `/tend-to-pr` just made — merging avoids a force-push. The repo squash-merges into `main`, so this merge commit is discarded at merge time anyway.
- **Resolve conflicts autonomously.** Conflict resolution is explicitly delegated to you. Read both sides, apply the conventions in `CLAUDE.md` and `services/graph-service/CLAUDE.md`, finish the merge, then re-run the pre-commit chain before pushing:

  ```bash
  pnpm --filter graph-service exec prettier --write .
  pnpm --filter graph-service lint
  pnpm --filter graph-service typecheck
  pnpm --filter graph-service test:unit:coverage
  ```

  Only `git merge --abort` and **stop to ask the human** when a conflict is genuinely ambiguous or resolving it would risk correctness.

- Equivalent for the clean (no-conflict) case: `gh api --method PUT repos/{owner}/{repo}/pulls/"$pr_number"/update-branch`. Prefer the local `git merge` path so you can handle conflicts in place.
- If `HEAD..origin/main` is `0`, the branch is already current — nothing to do.

**After Phase C:**

- If you pushed (tend fixes and/or a `main` merge), CI is running again → start the **next round at Phase A** (CI-only `--watch` is enough now).
- If nothing was pushed this round **and** CI is green **and** the branch is up to date with `main` → go to **Phase E**.
- After **3 rounds**, stop regardless and go to Phase E.

---

## Phase E — Notify and report

The PR is as merge-ready as this skill can make it. Tell the human it's their turn:

```bash
gh pr view "$pr_number" --json number,title,url,mergeStateStatus,statusCheckRollup
```

Send a **PushNotification** summarizing the outcome, e.g. _"PR #`$pr_number` is green and up to date with main — ready for your review and merge."_ If something still needs a human (unresolved conflict, a check still red after `/tend-to-pr`'s cap, a human-reviewer comment awaiting your call), say that instead.

Then print a short status in chat:

```
## Shepherded PR #{pr_number} — {title}

- CI: {all green | what's still failing}
- Tend: {ran — N comments answered, M CI fixes | not needed}
- main sync: {merged main in and pushed | already current | conflict needs you}
- Rounds used: {n}/3

### Your move
{Ready to merge ✅ | Needs you: …}
```

**Never run `gh pr merge`.** Merging is always the human's call.

---

## Guardrails

- **Act, don't ask, on every safe step** — running `/tend-to-pr`, updating the branch, resolving routine conflicts, fixing CI, replying to bot comments. The whole point is to not hang waiting for the user.
- **Only pause for genuine judgment:** (1) a non-trivial merge conflict with `main`, (2) a human-reviewer comment needing product judgment (handled inside `/tend-to-pr`), (3) a check still red after `/tend-to-pr`'s own 3-cycle cap. Otherwise finish with a notification, never a question.
- **Never merge the PR** — shepherd to merge-ready and hand back.
- **Never force-push.** Update the branch with `git merge origin/main` + `git push`. Never rebase-force an already-open branch.
- **Bounded at 3 rounds.** `main` doesn't require up-to-date branches to merge (its ruleset has no strict status-check policy), so a still-slightly-behind branch is still mergeable — don't chase a fast-moving `main` forever; report and stop.
- **Never** `git add -A` / `git add .` — stage specific files. **Never** `--no-verify`.
- Re-run the pre-commit chain (`prettier --write` → `lint` → `typecheck` → `test:unit:coverage`) after any conflict resolution before pushing.
