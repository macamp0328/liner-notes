# Changelog — versioned, plain-English, self-healing, changelog-as-data

A small system that turns merged pull requests into a readable, **versioned** changelog. Every
successful production deploy auto-cuts a **published, tagged CalVer release** (`vYYYY.MM.DD`)
describing exactly what went live, and a rolling **`unreleased` draft** shows what's merged but
not yet shipped. Open the repo's **Releases** tab to read it — the latest version shows up as
"Latest release" in the sidebar.

It is built around one idea: **a changelog is data, not prose.** There is a single structured
store; everything human-facing is a deterministic _render_ of it. That buys idempotency,
self-healing, machine-queryability, and a trivial historical backfill — properties a
string-appending bot can't have.

## Architecture

```
            ┌──── changelog.jsonl ────┐   ┌──── versions.json ────┐
            │ one record per PR,      │   │ one record per cut    │
  PR #312 ─►│ keyed by number;        │   │ version: tag, tier,   │
  deploy ─► │ `version` = its CalVer  │   │ headline, narrative,  │
  reconcile │ tag or null (unreleased)│   │ prNumbers, sha, model │
            └─────────────┬───────────┘   └───────────┬───────────┘
                          │  (both are ASSETS on the `unreleased` draft)
            ┌─────────────▼───────────────────────────▼─────────────┐
            │  render():  renderUnreleased  →  the draft body        │
            │             renderVersion     →  each published release│
            │             renderBaseline    →  the v0.1.0 history    │
            └────────────────────────────────────────────────────────┘
```

- **Store** — `changelog.jsonl` (one record per PR, keyed by number; `version` = the CalVer tag it
  shipped under, or `null` while unreleased) **and** `versions.json` (one record per cut version),
  both attached as **assets** on the single `unreleased` **draft** release. A draft is associated
  with a tag _name_ but **does not create the git tag ref until published**, so the store never
  tags or commits to `main`. Keyed by PR number / tag ⇒ every write is idempotent.
- **Published releases** — each cut version is a real, **published** GitHub Release with a tag at
  the deployed commit; its body is a rendered snapshot of that version's slice of the store.
  Creating a tag ref can't retrigger any branch-filtered workflow, so cutting is loop-free.
- **Render** ([`lib.ts`](lib.ts)) — pure functions `records → markdown`: `renderUnreleased` (the
  draft preview, flat + impact-tagged), `renderVersion` (one published release, tier-aware), and
  `renderBaseline` (the one-time history release, legacy week→category layout). Bodies are always
  a full re-render; we never hand-edit them.
- **Writer 1 — per-merge** ([`update.ts`](update.ts), [`changelog.yml`](../../.github/workflows/changelog.yml)):
  on every squash-merge to `main`, summarise the PR (`version: null`) and refresh the draft.
- **Writer 2 — the cut** ([`release.ts`](release.ts), [`changelog-release.yml`](../../.github/workflows/changelog-release.yml)):
  on a **successful deploy**, sweep everything Unreleased into one published CalVer release, stamp
  those records, and record the version.
- **Writer 3 — reconciler** ([`reconcile.ts`](reconcile.ts), [`changelog-reconcile.yml`](../../.github/workflows/changelog-reconcile.yml)):
  weekly, fill any gaps the per-merge path missed, back-fill version stamps, and **re-render every
  published release from the store with no new AI calls** — the release-world analog of the repo's
  fail-on-drift guards.
- **Backfill** ([`backfill.ts`](backfill.ts)): summarise the whole merged history in one **Message
  Batch** (50% cheaper) to seed the store on day one.

## Versions & importance tiers

A version is **CalVer** `vYYYY.MM.DD` (`.2`, `.3` for a second/third deploy the same day). The
**note richness ramps with importance**, scored deterministically from the version's records
(any breaking? any `Added`? max impact user/operator/developer? PR count) into one of three tiers:

| Tier            | Title                  | Body                                       |
| --------------- | ---------------------- | ------------------------------------------ |
| **Maintenance** | `vTAG — N changes`     | stats line + flat bullets (**no AI call**) |
| **Standard**    | `vTAG — <AI headline>` | headline (title) + stats + flat bullets    |
| **Notable**     | `vTAG — <AI headline>` | + a 2–3 sentence **narrative** lede        |

Headline/narrative are **frozen** in `versions.json` at cut time, so the reconciler re-renders any
release deterministically without re-calling Claude (a `style.md`/`version-style.md` edit has **no
retroactive effect** — that's intentional; use `--refresh` to opt in).

## AI quality

Each PR is summarised with **structured outputs** ([`claude.ts`](claude.ts)) — Claude returns a
schema-validated `{ category, summary, impact, breaking }` (up to two sentences) from the PR title,
body, labels, and diffstat. Version headlines/narratives are a separate, one-call-per-cut prompt.
The editorial voices are the committed [`style.md`](style.md) (per-PR) and
[`version-style.md`](version-style.md) (per-version) — tuning the changelog is a one-file PR.

**AI-enhanced, not AI-required:** with no `ANTHROPIC_API_KEY`, or on any API error, summaries fall
back to a cleaned PR title and version headlines to `vTAG — N changes` (`model: null`) — the merge
and deploy paths never fail. The visible disclosure line names the model used, or says "no AI".

## Files

| File               | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `lib.ts`           | Pure core: parse / week / tier / **render** / cut assembly.     |
| `lib.test.ts`      | `node:test` unit tests (`pnpm changelog:test`).                 |
| `claude.ts`        | Structured-output `summarize()` + `summarizeVersion()` + batch. |
| `claude.test.ts`   | Parsing/fallback unit tests.                                    |
| `store.ts`         | All `gh` I/O: PR fetch, draft store, published-release write.   |
| `update.ts`        | Per-merge fast path (`PR_NUMBER`).                              |
| `release.ts`       | The cut (`HEAD_SHA`) + the `--baseline` one-shot.               |
| `reconcile.ts`     | Reconciler: heal gaps + re-render published releases.           |
| `backfill.ts`      | One-shot historical seed.                                       |
| `style.md`         | Per-PR summariser system prompt.                                |
| `version-style.md` | Per-version headline/narrative system prompt.                   |

## Commands

```bash
pnpm changelog:test                               # unit tests
pnpm changelog:update 304                          # summarise one PR (also refreshes that entry)
DRY_RUN=1 pnpm changelog:update 304                # ...preview only, no writes
pnpm changelog:backfill                            # seed the store (run once after setup)
pnpm changelog:backfill --refresh                  # re-summarise EVERY entry (e.g. after editing style.md)
pnpm changelog:reconcile --since 2026-06-01        # heal a window + re-render releases on demand
HEAD_SHA=$(git rev-parse HEAD) pnpm changelog:release   # cut a version (normally CI-driven)
pnpm changelog:baseline                            # one-shot: publish the v0.1.0 history baseline
```

`DRY_RUN=1` prints what would happen and writes nothing (and `release` skips its AI heal). All
commands need `gh` auth (or `GH_TOKEN`); Claude summaries need `ANTHROPIC_API_KEY` (else they fall
back).

**Local env:** the scripts auto-load `.env.local` then `.env` from the repo root (via
[`env.ts`](env.ts)), so a key in either file is picked up without a manual `export` — a real
environment variable (CI secret) still wins. Both files are gitignored.

## Setup (one-time)

```bash
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>   # enables Claude summaries in CI
# put ANTHROPIC_API_KEY in .env.local (gitignored) for local runs, then:
pnpm changelog:backfill                                 # seed the project's history
pnpm changelog:baseline                                 # publish v0.1.0 "Initial history", empty Unreleased
# thereafter every successful deploy auto-cuts a vYYYY.MM.DD release.
```

## How a version is cut

1. A PR merges → `changelog.yml` summarises it into the store as `version: null` (Unreleased).
2. `deploy.yml` ships it to prod and its health gate passes.
3. `changelog-release.yml` fires on that success and runs `changelog:release`, which: ensures the
   merge is summarised (a short heal window), computes the CalVer tag + tier, writes headline /
   narrative for Standard+ / Notable, **publishes** the release, then stamps the records and
   appends the `VersionRecord`.
4. A same-SHA re-deploy with nothing pending **skips** the cut (no empty release).

## Forking / tuning

- **Cheaper model:** set `CHANGELOG_MODEL=claude-haiku-4-5` (in the workflow `env`, or your shell).
  Default is `claude-opus-4-8`.
- **Voice:** edit [`style.md`](style.md) (per-PR) or [`version-style.md`](version-style.md)
  (per-version). Per-PR re-render needs `pnpm changelog:backfill --refresh`; published release
  bodies only change on the next reconcile if their frozen metadata changes (they don't re-call AI).
- **Prefer a committed file over release assets?** `store.ts` is the only place that knows where the
  store lives — but writing to a protected `main` from CI needs a branch-protection bypass, which
  the release-asset design avoids.
