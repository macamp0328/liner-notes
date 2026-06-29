# Dependabot review — reference

## Risk decision matrix

Default verdict by semver jump, then adjust with the signals below.

| Jump                               | Default     | Notes                                                                                    |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| **patch** (`x.y.Z`)                | MERGE       | Bugfix-only by convention. Verify the changelog isn't a stealth behavior change.         |
| **minor** (`x.Y.z`)                | MERGE       | Additive by convention. Check for deprecations the lint/typecheck job would later fail.  |
| **major** (`X.y.z`)                | CLOSE+ISSUE | Breaking by convention. Merge only if the changelog proves nothing we use changed.       |
| **github-actions / docker digest** | MERGE       | Digest/patch pins. Major action tag bumps → treat as major.                              |
| **grouped `minor-and-patch`**      | MERGE       | Assess as a unit; one risky member sinks the whole PR → close + issue noting the member. |

**Signals that push a default toward MERGE:**

- The PR resolves a GHSA/CVE (security update) — the vuln usually outweighs upgrade risk.
- CI is fully green across all 9 required checks.
- Grep shows the package is unused or used only via stable surface.

**Signals that push toward CLOSE+ISSUE:**

- Red CI that isn't a trivial fix; peer-dependency / lockfile resolution conflicts.
- Changelog lists removed/renamed APIs, dropped Node version support (repo is **Node 22 LTS**), or a behavioral default change that the repo relies on.
- Broad blast radius (the package is imported across many files / is core: Fastify, neo4j-driver, vitest, typescript, eslint).
- Anything you can't confidently clear in a short surgical change.

**Special cases baked into `.github/dependabot.yml`:**

- `node` Docker base image: **major bumps are ignored by config** and are a deliberate manual call — if one ever appears, close + issue, never merge.
- `neo4j` docker-compose image: 5.26 is terminal for 5.x, so the next bump is a **major** surfaced on purpose for review — do not rubber-stamp it.

## Research playbook (web + changelog dig)

1. **npm package** — fetch `https://github.com/<org>/<repo>/releases` or the `CHANGELOG.md`; read every entry strictly between `old` and `new`. WebSearch `<pkg> <new-version> breaking changes` if the changelog is thin. Cross-check the npm page for a peer-deps bump.
2. **GitHub Action** — read the action repo's release notes for the tag range; watch for input renames, `node16→node20` runtime bumps, and required-permission changes.
3. **Docker image** — read the image's release notes / Dockerfile changes for the tag; for digest-only bumps, confirm the tag (e.g. `22-slim`) is unchanged.
4. **CVE/GHSA** — if linked, open the advisory; confirm the fixed version ≥ the new version and that the vulnerable code path is one we actually hit.

Always tie the finding back to **our** usage (Phase 2 grep). "Breaking in general" ≠ "breaks us".

## Repo command gotchas (load-bearing for 4b)

These come from hard-won memory — get them wrong and the pre-push hook or CI rejects the fix:

- **Lockfile changes need pnpm 9.15.9.** Use `corepack pnpm@9.15.9 install`. Global pnpm 10/11 strips `libc` fields (noisy diff) and pnpm 11 ignores `pnpm.overrides`. CI uses pnpm 9 + frozen-lockfile.
- **Fresh worktree has no `node_modules`.** Run `pnpm install` before any commit/push or the pre-push hook (lint/typecheck/test) fails.
- **Untrusted `.mise.toml` in a worktree clobbers PATH** in subshells (`curl`/`jq`/`gh` vanish). Use absolute binary paths, or run git/gh from the primary checkout.
- **Run `pnpm verify` before pushing** — it mirrors the offline CI half (prettier→markdownlint→lint→typecheck→unit coverage→scripts:test). The coverage gate is enforced pre-push exactly as in CI.
- **`main` is protected by a ruleset:** PR required, force-push blocked, linear history, 9 required status checks (a curated subset — not every ci.yml job blocks). Squash-merge only. Up-to-date-with-main is **not** required, so a slightly-behind Dependabot branch still merges.
- **Branch/commit:** Dependabot owns its `dependabot/...` branch. Pushing a commit there makes Dependabot stop managing it — fine, since we intend to merge. For a fresh accommodation branch instead, use `task/{n}-{desc}` naming.

## `@dependabot` chat commands (alternative to gh)

Comment these on the PR if you'd rather Dependabot act: `@dependabot merge` (merges after CI), `@dependabot squash and merge`, `@dependabot rebase`, `@dependabot recreate`, `@dependabot close`. Prefer the explicit `gh pr merge --squash` / `gh pr close` so the action is logged under your run.

## Templates

### Merge-verdict comment (4a)

```
✅ Merging — <pkg> <old> → <new> (<patch|minor|major>).
Changelog between versions: <one-line summary, no breaking changes affecting us>.
CI: all required checks green. Blast radius: <where/how we use it, or "unused surface">.
```

### Surgical-fix verdict comment (4b)

```
✅ Merging with a surgical accommodation — <pkg> <old> → <new>.
<what changed in the dep> required <the one-line fix>; added a regression test (<file>).
`pnpm verify` green locally; CI re-run green.
```

### Close-verdict comment (4c)

```
Closing in favor of #<issue> — <pkg> <old> → <new> is a <reason: major with breaking X / peer-dep conflict with Y>.
Tracked there to keep this update scoped and reviewable.
```

### Scoped upgrade issue (4c / Phase 5)

```
Title: Upgrade <pkg> <old> → <new>

## What
Dependabot opened (and we closed) PR #<n> bumping `<pkg>` <old> → <new>.

## Why it wasn't auto-merged
<the specific blocker: breaking API X we use in <file>; peer-dep conflict; major needing manual call>.

## Risks / changelog notes
- <breaking change 1 + the repo file(s) it touches>
- <CVE/GHSA if a security bump, with severity>

## Suggested approach
<surgical steps to do the upgrade safely — the minimal path>.

## Scope
Just this upgrade. Do not bundle other bumps.
```

Label per [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md): one `status` (`ready-for-agent` for fully-specified, `needs-triage` if it needs a judgment call) + one `area:*` + one `type` (usually `chore`; `bug` if the bump fixes a defect) + one `priority:*` (security `high`/`critical` → `priority:high`).
