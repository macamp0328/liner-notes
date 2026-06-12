---
status: accepted
---

# Issue organization: a four-axis label taxonomy + a saved-filter queue, not a project board

## Context

Claude Code creates almost all issues in this repo. Until now the tracker used only GitHub's ten
stock labels: ~78% of labeled open issues were just `enhancement`, ~18% were unlabeled, and there
was no signal for component, lifecycle, or priority. The concrete pain: choosing the next issue to
hand an agent meant reading the whole open list (~27 issues) every time.

The repo is a **User** account, not an org. That rules out GitHub's org-only features (native Issue
Types, the native blocked-by/blocking dependency graph) and means GitHub Projects v2 would need a
token re-auth (`project` scope) plus manual board setup. The guiding constraint from the maintainer:
keep it **helpful and automatic, not deep or costly to sustain** — nothing that needs ongoing manual
curation.

## Decision

Organize issues with a **four-axis namespaced label taxonomy**, applied automatically by Claude Code
at creation, and surface "what's next" through **saved GitHub search filters** rather than a board.
The authoritative label list and the bookmark queries live in
[`docs/agents/triage-labels.md`](../agents/triage-labels.md).

- **Status** (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) — reuses
  the matt-pocock `triage` skill's canonical strings 1:1. `blocked` is an orthogonal modifier (it
  co-exists with `ready-*`), capturing "depends on an open issue" without a native dependency graph.
- **Area** — eight `area:*` labels, one per monorepo component (`src/ingestion`, `src/enrichment`,
  `src/db`→`graph`, `src/api`, `infra`, `.github`→`ci`, `scripts`, `docs`).
- **Type** — `enhancement` / `bug` / `refactor` / `chore` (+ `good first issue`).
- **Priority** — `priority:high|medium|low`, assigned by a fixed rule (high = keystone-that-unblocks
  or prod bug; low = nice-to-have / measure-first; medium = default) so it is never hand-curated.

The pickup workflow is a bookmarked filter:
`is:open label:"ready-for-agent" label:"priority:high" -label:"blocked"` → take the top item →
`/issue <url>`. Relationships are captured by the `blocked` label + a `## Blocked by #N` body line
(both queryable), not by a manually-maintained sub-issue tree.

The taxonomy stays current because the issue-creating skills (`to-issues`, `triage`, `issue`) stamp
all four axes at creation; the `## Issue Organization` section of the root `CLAUDE.md` holds the
always-loaded auto-apply rule.

## Consequences

- Picking the next agent task is a one-click bookmark, not a backlog scan. The judgment-needed work
  is routed to a separate `needs-triage` / `ready-for-human` bucket, so the `ready-for-agent` queue
  is safe to hand off blind.
- `blocked` does not clear itself when a keystone merges — the maintainer runs `/triage` ("unblock
  dependents of #N") once. With few blockers (currently all trace to #330) this is cheap; an
  `issues.closed` GitHub Action that strips `blocked` was considered and deferred as not worth a
  standing CI file yet.

## Alternatives rejected

- **GitHub Projects v2 board** — needs a token re-auth + manual board/field/view setup + ongoing card
  maintenance; the `status:` labels already encode what a board's Status field would.
- **Milestones / native sub-issue trees** — per-issue manual upkeep; `area:*` labels + saved filters
  give the same grouping for free.
- **Native Issue Types & dependency graph** — org-only; unavailable on a User repo.
- **A `priority:` axis maintained across the whole backlog** — rejected in favor of rule-based
  assignment at creation, so priority never becomes a curation chore.
