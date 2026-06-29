---
name: dependabot-review
description: Sweep every open Dependabot PR and Dependabot security alert in one pass, dig into changelogs/CVEs/breaking changes between the old and new versions, then drive each to a terminal state — merge the safe ones (after a surgical fix or regression test if that's all it takes), or close the risky ones and open a single scoped issue to track the upgrade. Use when the user wants to clear the Dependabot backlog, review dependency-bump PRs, triage security vulnerabilities / Dependabot alerts, or says "review the dependabot PRs", "clear the dep updates", "handle the security PRs".
disable-model-invocation: true
tools: Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch
---

# Review & clear the Dependabot queue

Take **every** open Dependabot PR and security alert to a terminal state in one sweep. There are exactly two outcomes per PR — there is no "leave it open for later":

- **MERGE** — the bump is safe (or made safe by a surgical fix / regression test you add), CI is green → squash-merge it.
- **CLOSE + ISSUE** — the bump causes a dependency conflict or needs real work → close the PR and open **one** minimal, scoped issue capturing the upgrade and its risks, so the queue stays clean and the work is tracked.

Optional argument: a single PR number to scope the run to just that PR. **Default = sweep all open Dependabot PRs + alerts.**

**Scope to review:** $ARGUMENTS

## Live Context

- Open Dependabot PRs: !`gh pr list --author "app/dependabot" --state open --json number,title,headRefName,labels --jq '.[] | "#\(.number) \(.title)"' 2>/dev/null || echo "none / gh not ready"`
- Open Dependabot alerts: !`gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[] | select(.state=="open")] | length' 2>/dev/null || echo "n/a"`
- Dependabot ecosystems: !`grep -E 'package-ecosystem' .github/dependabot.yml 2>/dev/null || echo "no config"`

---

## Read first

- **[REFERENCE.md](REFERENCE.md)** — the risk decision matrix, per-ecosystem research playbook, repo-specific command gotchas (pnpm 9.15.9, worktrees, `pnpm verify`), and the issue/comment templates. Read it before Phase 2.

## Guardrails

- **This skill is the authorized exception to "agents never merge."** Its explicit job is to clear the queue, so it _does_ squash-merge PRs that pass the gate. It still **never** merges anything with red/pending CI, and never force-pushes `main`.
- **Every action leaves an audit trail.** Before you merge or close a PR, post a comment on it stating the verdict and the one-line reason (see templates). Never act silently.
- **One issue per closed PR, scoped tight.** The issue covers _only_ that upgrade. Do not bundle unrelated bumps or expand into a refactor. Minimal scope is the whole point.
- **When genuinely unsure whether a bump is safe, treat it as risky** → close + issue. A tracked upgrade beats a merged regression.
- **Grouped PRs** (`minor-and-patch`) are normal — assess the group as a unit; if _any_ member is risky, close the whole PR and note which member in the issue.

---

## Phase 1 — Enumerate

```bash
gh pr list --author "app/dependabot" --state open \
  --json number,title,headRefName,labels,createdAt
```

If `$ARGUMENTS` is a PR number, narrow to just that one. Build a worklist; process each PR through Phases 2–4. After the PR sweep, do Phase 5 (alerts with no PR).

## Phase 2 — Investigate each PR

For one PR at a time:

1. **Identify the change.** `gh pr view <n> --json title,body,headRefName` — package, ecosystem (npm / github-actions / docker / docker-compose), and the `old → new` versions. Note the **semver jump** (patch / minor / major) and Dependabot's compatibility score from the body.
2. **CI status.** `gh pr checks <n>` — note which of the 9 required checks are green/red/pending. Red CI is a strong signal (often the surgical-fix path; sometimes the close path).
3. **Security context.** If the body links a GHSA/CVE, this is a _security_ update — bias toward merging (the vuln is the bigger risk) but still verify.
4. **Dig the changelog (web + changelog dig).** Fetch release notes / CHANGELOG between old and new versions (WebFetch the repo's releases or changelog). Look for: breaking changes, removed/renamed APIs, behavioral shifts, peer-dependency bumps, dropped runtime support. See REFERENCE.md → "Research playbook".
5. **Blast radius.** Grep the repo for how the package is actually used (`Grep` the import/usage). A breaking change you don't touch is not a breaking change _for us_.

## Phase 3 — Decide (per the matrix in REFERENCE.md)

- **SAFE** → Phase 4a (merge).
- **SAFE AFTER A SURGICAL FIX** — a small code change and/or a regression unit test makes the bump safe (e.g. an API renamed, a default changed). The accommodation is small and local → Phase 4b.
- **RISKY / DEPENDENCY CONFLICT** — major bump with real breaking changes, peer-dep / lockfile conflicts, broad blast radius, or anything needing genuine work → Phase 4c (close + issue).

## Phase 4 — Act

### 4a. Merge (safe)

Post the merge-verdict comment, then squash-merge:

```bash
gh pr comment <n> --body "<verdict>"        # see REFERENCE.md template
gh pr merge <n> --squash --delete-branch
```

### 4b. Surgical fix / regression test, then merge

The repo command gotchas in REFERENCE.md are **load-bearing** here (pnpm 9.15.9 for lockfile, `pnpm install` in a fresh worktree, absolute binary paths, `pnpm verify` before push).

```bash
gh pr checkout <n>                          # onto the dependabot/... branch
# ... make the minimal change + add/adjust a unit test ...
pnpm verify                                  # prettier→lint→typecheck→unit coverage→scripts
git commit -am "task: accommodate <pkg> <new-ver> + regression test"
git push
```

Then wait for CI to re-run green and merge as in 4a. If the fix turns out to be non-trivial, **abandon it** and fall through to 4c instead.

### 4c. Close + open a scoped issue

Open the issue **first** (so the PR comment can link it), then close:

```bash
gh issue create --title "Upgrade <pkg> <old> → <new>" \
  --body "<body — see REFERENCE.md template>" \
  --label "ready-for-agent" --label "area:<x>" --label "chore" --label "priority:<x>"
gh pr comment <n> --body "Closing in favor of #<issue> — <one-line reason>."
gh pr close <n> --delete-branch
```

Apply the four-axis labels per [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md). github-actions/docker bumps → `area:ci` + `chore`; npm runtime deps → the affected `area:*`. A security bump that can't merge cleanly → `priority:high`.

## Phase 5 — Alerts with no PR

Some Dependabot **alerts** never get an auto-PR (transitive deps, or security updates disabled for that ecosystem). Sweep them:

```bash
gh api repos/{owner}/{repo}/dependabot/alerts \
  --jq '.[] | select(.state=="open") | {ghsa: .security_advisory.ghsa_id, sev: .security_advisory.severity, pkg: .dependency.package.name, range: .security_vulnerability.vulnerable_version_range}'
```

For each open alert without a corresponding PR, open one scoped issue (severity → priority; `area:*` from where the dep lives). Don't attempt the upgrade in this sweep — file it.

## Phase 6 — Summary

End with a table: **PR | package | old→new | verdict | outcome (merged / #issue)**, plus an Alerts section. State plainly what merged, what was closed-and-filed, and anything that needs Miles's judgment.
