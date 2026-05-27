---
name: diagrams
description: Regenerate or update the architecture diagrams under infra/diagrams/. Use when the user wants to refresh diagrams after Terraform changes, draft the hand-maintained request-flow diagram, or asks anything like "update the architecture diagram", "redraw the infra diagram", "what does the deploy look like now".
disable-model-invocation: true
tools: Bash, Read, Edit, Write, Glob, Grep
---

# Architecture diagrams

Two modes, dispatched on `$ARGUMENTS`:

- **regenerate** (default — no args, or `regenerate` / `update`) → run `pnpm diagrams:generate`. Use after any change under `infra/terraform/**` to refresh `resource-graph.svg` and the per-file Mermaid diagrams.
- **draft** (`draft` / `edit` / `update flow` / `redraw flow`) → interactively help the user update `infra/diagrams/request-flow.mmd` (the hand-maintained logical request flow), then regenerate.

**Mode requested:** $ARGUMENTS

## Live Context

- Repo root: !`pwd`
- Diagrams dir: !`ls infra/diagrams/ 2>/dev/null`
- Per-file diagrams: !`ls infra/diagrams/per-file/ 2>/dev/null`
- Terraform files: !`ls infra/terraform/*.tf 2>/dev/null`
- Last diagram-related commits: !`git log --oneline -5 -- infra/diagrams/ scripts/diagrams/ infra/diagrams/request-flow.mmd 2>/dev/null`

---

## Tooling check

Both tools are required. If either is missing, install and re-run.

```bash
which inframap dot
# Expected: /opt/homebrew/bin/inframap, /opt/homebrew/bin/dot
# If missing:  brew install inframap graphviz
```

---

## Mode: regenerate

Just run the generator. It is idempotent — re-running with no Terraform changes will produce zero diffs.

```bash
pnpm diagrams:generate
```

It outputs:

- `infra/diagrams/resource-graph.svg` — full Inframap raw resource graph
- `infra/diagrams/per-file/<name>.mmd` — one Mermaid diagram per `.tf` file
- Inlines `infra/diagrams/request-flow.mmd` into `README.md` and `infra/RUNBOOK.md` between `<!-- diagrams:request-flow:start -->` / `:end` markers

Then `git status` to show the user what changed.

```bash
git status -s infra/diagrams/ README.md infra/RUNBOOK.md
```

If nothing changed, say so — don't fabricate a diff. If files did change, summarize: "Updated N per-file diagrams; resource-graph.svg unchanged" or similar.

---

## Mode: draft

The user wants to update the **hand-maintained logical request flow**. The source of truth is `infra/diagrams/request-flow.mmd`. The generator inlines it into README and RUNBOOK, so this file is the only place to edit.

### Step 1 — Read the current diagram and recent infra changes

```bash
cat infra/diagrams/request-flow.mmd
git log --oneline -10 -- infra/terraform/ infra/k8s/
```

### Step 2 — Establish what's changing

Ask the user — in one focused round — what's changing in the request flow. Examples of triggers:

- A new external service is being added (e.g. Cloudflare, a new API)
- The ingress path is changing (NodePort → ALB, new domain)
- Secrets or image-pull mechanics shift (e.g. IRSA instead of IMDS)
- A new component appears in the cluster (e.g. a sidecar, a job)
- An existing arrow needs a new label or different style (solid → dashed for async)

If they want a full redraw rather than an edit, propose a structure first (which subgraphs, which external nodes, which arrows) before touching the file.

### Step 3 — Edit `infra/diagrams/request-flow.mmd`

Mermaid `flowchart` syntax cheatsheet (matches the existing diagram conventions):

| Element             | Syntax                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| External entity     | `name([User]):::ext` + `classDef ext fill:#f4f4f4,stroke:#999,stroke-dasharray:5 3` |
| Service             | `svc[/"Service · NodePort"/]`                                                       |
| Pod / container     | `pod["Pod · graph-service"]`                                                        |
| Secret / data store | `db[("Secret · …")]`                                                                |
| Boundary group      | `subgraph aws["AWS account"] … end`                                                 |
| Synchronous request | `a -- "label" --> b`                                                                |
| Heavy data path     | `a == "Cypher" ==> b`                                                               |
| Async / out-of-band | `a -.label.-> b`                                                                    |
| Layout hint         | `direction TB` inside a subgraph                                                    |

Conventions used by the existing diagram:

- **External nodes** (user, Aura, Discogs) use rounded `([...])` and the `:::ext` class.
- **Solid arrows** = ingress request path or the response back.
- **Thick `==>` arrows** = high-volume data flows (Cypher, image pull).
- **Dotted `-.-> ` arrows** = async, scheduled, or out-of-band flows (CronJob writes, ESO sync).
- Subgraphs nest: `aws → vpc → ec2 → ns` and `aws → vpc → ec2 → eso` for the parallel external-secrets namespace.

Keep the diagram **logical, not literal** — it should encode intent (what talks to what, and how) rather than every Terraform resource. The auto-generated `resource-graph.svg` covers literal completeness.

### Step 4 — Regenerate

```bash
pnpm diagrams:generate
```

### Step 5 — Verify in markdown

Both README and RUNBOOK should now have the updated Mermaid block between their markers. GitHub renders the block natively — no extra preview step needed unless the user asks.

```bash
git diff README.md infra/RUNBOOK.md infra/diagrams/request-flow.mmd
```

If the diff looks right, hand back to the user with a one-line summary of what changed. Don't commit unless they ask — diagram changes typically ride along with the infra change that motivated them.

---

## Common pitfalls

- **Stale markdown copy after editing `request-flow.mmd`** → did you run `pnpm diagrams:generate`? The inline copy in README/RUNBOOK is only updated by the script.
- **Resource graph looks empty / only shows EC2** → you're probably looking at Inframap's curated (default) output. The script uses `--raw` for completeness; if you tried `inframap generate ...` by hand without `--raw`, that's the difference.
- **Per-file Mermaid shows an external resource not appearing in any file** → likely a `data` block reference. Confirm by grepping `infra/terraform/` for `data "<type>"`.
- **CI pushed a `chore(diagrams): regenerate` commit you didn't expect** → the [`diagrams.yml` workflow](../../.github/workflows/diagrams.yml) auto-commits on PRs touching `infra/terraform/**`. This is expected; reset/rebase if you didn't want it.
