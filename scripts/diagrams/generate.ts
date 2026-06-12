#!/usr/bin/env tsx
// Regenerate architecture diagrams under infra/diagrams/.
//
// Outputs:
//   resource-graph.svg    — Inframap --raw view (every resource + dependency)
//   per-file/<name>.mmd   — one Mermaid diagram per .tf file
//   request-flow.mmd      — hand-maintained, source of truth, inlined into
//                           markdown files between marker comments.
//
// Inframap's default "curated" view embeds AWS icons from a local cache via
// absolute file paths, which won't render outside the author's machine. We
// use --raw so the SVG is self-contained and portable.
//
// Graphviz rendering runs in a pinned Docker image (nshine/dot:2.40.1) so the
// SVG bytes are identical across Mac (brew), Ubuntu CI (apt), and anywhere
// else this script runs. Without the pin, every PR triggered a 200+-line SVG
// churn diff just from version drift between local and CI graphviz.
//
// Readability: Inframap's raw DOT is a flat list of 34 ellipses with truncated
// labels. We post-process the DOT (postProcessDot) to:
//   - group resources by category cluster (IAM, Networking, Compute, ...)
//   - color-code each cluster
//   - replace ellipses with rounded boxes
//   - strip the `aws_` prefix from labels (the cluster color carries provider)
//   - apply Helvetica + orthogonal splines + concentrate=true
// Same DOT input → same SVG; ordering is deterministic.
//
// Markdown inlining: for each (mmdName, [files]) entry in MARKDOWN_TARGETS we
// look for the marker pair:
//   <!-- diagrams:<mmdName>:start -->
//   <!-- diagrams:<mmdName>:end -->
// in each file and replace the content between them with a ```mermaid fence
// containing request-flow.mmd. This keeps README + RUNBOOK in sync from one
// source.
//
// Requires `inframap` and `docker` on PATH (and the Docker daemon running).
// README documents install.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const TF_DIR = join(REPO_ROOT, 'infra', 'terraform');
const OUT_DIR = join(REPO_ROOT, 'infra', 'diagrams');
const PER_FILE_DIR = join(OUT_DIR, 'per-file');

type ResourceRef = {
  kind: 'resource' | 'data';
  type: string;
  name: string;
  file: string;
};

type Address = string; // e.g. "aws_vpc.main" or "data.aws_ami.al2023"

const SKIP_FILES = new Set(['outputs.tf', 'variables.tf']);

// Which markdown files should have which .mmd inlined into them.
const MARKDOWN_TARGETS: Record<string, string[]> = {
  'request-flow': ['README.md', 'infra/RUNBOOK.md'],
};

function listTfFiles(): string[] {
  return readdirSync(TF_DIR)
    .filter((f) => f.endsWith('.tf') && !SKIP_FILES.has(f))
    .sort();
}

// Strip line and block comments so they can't produce false-positive matches.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])(\/\/|#)[^\n]*/g, '$1');
}

type Block = { decl: ResourceRef; body: string };

// Extract each `resource|data "type" "name" { ... }` block via brace-matching.
// Tracks string literals so braces inside HCL strings don't throw off the
// depth counter. Returns the inner body (without the outer braces) per block,
// which is what we scan for cross-resource references.
function parseBlocks(src: string, file: string): Block[] {
  const out: Block[] = [];
  // Reset regex state by constructing a fresh stateful matcher.
  const headerRE = /^(resource|data)\s+"([a-zA-Z0-9_-]+)"\s+"([a-zA-Z0-9_-]+)"\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = headerRE.exec(src))) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '"') {
        // Walk over a string literal (HCL allows escapes and ${...} interp).
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') i++;
          i++;
        }
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
      }
      i++;
    }
    const kind = m[1];
    const type = m[2];
    const name = m[3];
    // The header regex guarantees all three capture groups; the guard just
    // satisfies noUncheckedIndexedAccess without altering runtime behaviour.
    if (kind === undefined || type === undefined || name === undefined) continue;
    out.push({
      decl: {
        kind: kind as 'resource' | 'data',
        type,
        name,
        file,
      },
      body: src.slice(bodyStart, i - 1),
    });
  }
  return out;
}

function addressOf(r: ResourceRef): Address {
  return r.kind === 'data' ? `data.${r.type}.${r.name}` : `${r.type}.${r.name}`;
}

// Split a Terraform address into its resource type + name, tolerating the
// optional `data.` prefix (`data.aws_ami.x` → type `aws_ami`, name `x`;
// `aws_instance.k3s` → type `aws_instance`, name `k3s`). A missing segment
// falls back to the whole address so the result is always a string — a
// well-formed address always has the segments; the fallback only satisfies
// noUncheckedIndexedAccess for the categorize()/label callers.
function splitAddress(addr: string): { type: string; name: string } {
  const segments = addr.split('.');
  return addr.startsWith('data.')
    ? { type: segments[1] ?? addr, name: segments[2] ?? addr }
    : { type: segments[0] ?? addr, name: segments[1] ?? addr };
}

// Find which declared addresses are referenced in `src`. We look for token
// patterns and intersect with the known set so we never invent references.
function findReferences(src: string, known: Set<Address>): Set<Address> {
  const found = new Set<Address>();
  // Resource refs: aws_foo.bar(.attr)?
  const RES_RE = /\b([a-z][a-z0-9_]+)\.([a-z][a-z0-9_]+)/g;
  for (const m of src.matchAll(RES_RE)) {
    const addr = `${m[1]}.${m[2]}`;
    if (known.has(addr)) found.add(addr);
  }
  // Data refs: data.aws_foo.bar
  const DATA_RE = /\bdata\.([a-z][a-z0-9_]+)\.([a-z][a-z0-9_]+)/g;
  for (const m of src.matchAll(DATA_RE)) {
    const addr = `data.${m[1]}.${m[2]}`;
    if (known.has(addr)) found.add(addr);
  }
  return found;
}

function mermaidId(addr: Address): string {
  return addr.replace(/[^a-zA-Z0-9]/g, '_');
}

// Pull the first leading `# …` comment line out of a .tf file to use as the
// subgraph caption. Most files in infra/terraform/ open with a one-sentence
// summary; falling back to null is fine — the caption is purely additive.
function extractCaption(raw: string): string | null {
  const firstLine = raw.split('\n')[0]?.trim();
  if (!firstLine || !firstLine.startsWith('#')) return null;
  const text = firstLine.replace(/^#+\s*/, '').trim();
  if (!text) return null;
  // Keep the caption Mermaid-safe: no quotes (would break the subgraph label)
  // and no angle brackets (could be mistaken for HTML by some renderers).
  return text.replace(/["<>]/g, '').slice(0, 80);
}

type ResourceEdge = {
  from: Address; // an address declared in this file
  to: Address; // any known address (same file or another file)
};

// Render a per-resource Mermaid node label. Mirrors the icon + bold-name +
// short-type layout used by the resource-graph SVG so the two views read as
// one family. For data sources we keep the resource-type glyph (📜 for a
// policy doc stays a policy doc) and move the 📥 lookup badge into the small
// caption so the leading icon column stays uniform.
function nodeLabel(addr: Address, type: string, name: string): string {
  const icon = iconFor(type);
  const caption = addr.startsWith('data.') ? `📥 ${shortTypeLabel(type)}` : shortTypeLabel(type);
  return `${icon} ${name}<br/><small>${caption}</small>`;
}

// Mermaid classDef block for one category. Fill matches CATEGORY_META so the
// per-file diagrams use the same palette as the SVG; stroke + text colors are
// fixed dark slate for contrast on the pastel fills.
function categoryClassDef(cat: Category): string {
  const meta = CATEGORY_META[cat];
  return `  classDef ${cat} fill:${meta.fill},stroke:#475569,color:#0f172a`;
}

function buildPerFileMermaid(
  file: string,
  fileCaption: string | null,
  blocksInFile: Block[],
  edges: ResourceEdge[],
  declToFile: Map<Address, string>,
): string {
  const lines: string[] = [];
  lines.push('%% Auto-generated by scripts/diagrams/generate.ts — do not edit by hand.');
  lines.push(`%% Source: infra/terraform/${file}`);

  // LR for every file. We experimented with TB for files with more resources,
  // but Mermaid lays hub-and-spoke graphs (observability.tf especially) much
  // wider top-down than left-right, so LR wins on both fan-out files and
  // small ones — one consistent rule, less surprise.
  const direction = 'LR';
  lines.push(`flowchart ${direction}`);

  const declAddrs = new Set(blocksInFile.map((b) => addressOf(b.decl)));
  const externalAddrs = new Set<Address>();
  for (const e of edges) if (!declAddrs.has(e.to)) externalAddrs.add(e.to);

  // Emit one classDef per category present in this file (own or referenced),
  // so every node can be tagged with its category color without dragging in
  // unused styles. Sorted for deterministic output.
  const categoriesUsed = new Set<Category>();
  for (const b of blocksInFile) categoriesUsed.add(categorize(b.decl.type));
  for (const addr of externalAddrs) {
    categoriesUsed.add(categorize(splitAddress(addr).type));
  }
  for (const cat of [...categoriesUsed].sort()) {
    lines.push(categoryClassDef(cat));
  }

  // Subgraph: resources declared in this file. Caption (first `# …` line of
  // the source .tf) is appended to the file name so the diagram explains what
  // it's showing without the reader having to open the Terraform.
  const title = fileCaption ? `${file} — ${fileCaption}` : file;
  lines.push(`  subgraph this["${title}"]`);
  lines.push(`    direction ${direction}`);
  for (const b of blocksInFile) {
    const addr = addressOf(b.decl);
    const cat = categorize(b.decl.type);
    const label = nodeLabel(addr, b.decl.type, b.decl.name);
    lines.push(`    ${mermaidId(addr)}["${label}"]:::${cat}`);
  }
  lines.push('  end');

  // External resources, grouped by source file. Stable order via sort. Same
  // icon + short-type label as the in-file nodes — only the node shape
  // (rounded vs. square) signals "external".
  const byFile = new Map<string, Address[]>();
  for (const addr of [...externalAddrs].sort()) {
    const f = declToFile.get(addr) ?? 'unknown';
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f)!.push(addr);
  }
  for (const [otherFile, addrs] of [...byFile.entries()].sort()) {
    const sgId = `ext_${mermaidId(otherFile)}`;
    lines.push(`  subgraph ${sgId}["${otherFile}"]`);
    for (const addr of addrs) {
      const { type: resourceType, name: resourceName } = splitAddress(addr);
      const cat = categorize(resourceType);
      const label = nodeLabel(addr, resourceType, resourceName);
      lines.push(`    ${mermaidId(addr)}(["${label}"]):::${cat}`);
    }
    lines.push('  end');
  }

  // Edges. Intra-file edges (both endpoints declared here) are solid; cross-
  // file edges are dashed. Self-references are skipped. Edges are sorted and
  // deduplicated for deterministic, churn-free output.
  const seen = new Set<string>();
  const sortedEdges = [...edges].sort((a, b) =>
    (a.from + ' -> ' + a.to).localeCompare(b.from + ' -> ' + b.to),
  );
  for (const e of sortedEdges) {
    if (e.from === e.to) continue;
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arrow = declAddrs.has(e.to) ? '-->' : '-.->';
    lines.push(`  ${mermaidId(e.from)} ${arrow} ${mermaidId(e.to)}`);
  }

  return lines.join('\n') + '\n';
}

function run(cmd: string, args: string[], opts: { input?: string } = {}): Buffer {
  const r = spawnSync(cmd, args, {
    input: opts.input,
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr?.toString() ?? ''}`,
    );
  }
  return r.stdout;
}

// Pinned via tag + digest. Graphviz layout is version-sensitive, so a Mac
// running brew's graphviz 15.x produces a different SVG than Ubuntu CI's apt
// graphviz 2.43.x for the same DOT input — causing per-PR SVG churn even
// when nothing semantic changed. Routing rendering through a pinned image
// makes the SVG byte-stable across machines.
const GRAPHVIZ_IMAGE =
  'nshine/dot:2.40.1@sha256:17ba91db2197ae4154cdc4b397a263017ce15c7f2c0cb8bf29404d78bcb4bd6d';

function ensureToolsAvailable(): void {
  for (const [tool, hint] of [
    [
      'inframap',
      'macOS: brew install inframap   CI: go install github.com/cycloidio/inframap@v0.8.1',
    ],
    ['docker', 'install Docker Desktop on Mac, or use a Linux box with the docker daemon running'],
  ] as const) {
    const r = spawnSync('which', [tool]);
    if (r.status !== 0) {
      console.error(`\n❌ "${tool}" not found on PATH.\n   ${hint}\n`);
      process.exit(1);
    }
  }
}

// Read a file and treat ENOENT as a missing-file signal rather than throwing.
// Avoids the existsSync→readFileSync race that CodeQL flags as TOCTOU.
function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Read a .mmd file and strip the leading %% header-comment block (the
// "this file is the source of truth" preamble). Inlined output should be
// just the diagram itself. Returns null if the file does not exist.
function loadMermaidBody(mmdPath: string): string | null {
  const raw = tryReadFile(mmdPath);
  if (raw === null) return null;
  const lines = raw.split('\n');
  // Drop leading %% comment lines (and any blank lines between them).
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || !(line.startsWith('%%') || line.trim() === '')) break;
    i++;
  }
  return lines.slice(i).join('\n').trimEnd();
}

function inlineIntoMarkdown(mmdName: string, body: string, targets: string[]): void {
  const startMarker = `<!-- diagrams:${mmdName}:start -->`;
  const endMarker = `<!-- diagrams:${mmdName}:end -->`;
  const fenced = `${startMarker}\n\n\`\`\`mermaid\n${body}\n\`\`\`\n\n${endMarker}`;

  for (const rel of targets) {
    const path = join(REPO_ROOT, rel);
    const src = tryReadFile(path);
    if (src === null) {
      console.warn(`  ⚠️  ${rel} not found — skipping inline`);
      continue;
    }
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) {
      console.warn(`  ⚠️  ${rel} is missing marker pair for "${mmdName}" — skipping inline`);
      continue;
    }
    const updated = src.slice(0, startIdx) + fenced + src.slice(endIdx + endMarker.length);
    if (updated === src) {
      console.log(`  ${rel} already up to date`);
    } else {
      writeFileSync(path, updated);
      console.log(`  inlined ${mmdName} into ${rel}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resource categorization — drives both cluster grouping and color in the
// final SVG. Extend the regexes when a new family of AWS resources lands.
// ---------------------------------------------------------------------------

type Category =
  | 'iam'
  | 'compute'
  | 'networking'
  | 'observability'
  | 'storage'
  | 'secrets'
  | 'edge'
  | 'other';

const CATEGORY_META: Record<Category, { label: string; fill: string; order: number }> = {
  networking: { label: 'Networking', fill: '#dcfce7', order: 1 }, // soft green
  compute: { label: 'Compute', fill: '#dbeafe', order: 2 }, // soft blue
  iam: { label: 'IAM & Identity', fill: '#fef3c7', order: 3 }, // soft yellow
  secrets: { label: 'Secrets', fill: '#ede9fe', order: 4 }, // soft purple
  storage: { label: 'Storage & Registry', fill: '#ffedd5', order: 5 }, // soft orange
  observability: { label: 'Observability', fill: '#fce7f3', order: 6 }, // soft pink
  edge: { label: 'Edge & DNS', fill: '#cffafe', order: 7 }, // soft cyan
  other: { label: 'Other', fill: '#f1f5f9', order: 8 }, // soft gray
};

function categorize(resourceType: string): Category {
  const t = resourceType.replace(/^aws_/, '');
  if (/^(iam_|caller_identity)/.test(t)) return 'iam';
  if (/^(instance|eip|ami|launch_template|autoscaling|ebs)/.test(t)) return 'compute';
  // `route_table` (not bare `route`) so we don't poach `route53_*` resources,
  // which are handled by the observability / edge rules below.
  if (/^(vpc|subnet|internet_gateway|route_table|security_group|nat_gateway|network_acl)/.test(t))
    return 'networking';
  if (/^(cloudwatch|sns|sqs|cloudtrail)/.test(t)) return 'observability';
  if (/^(route53_health)/.test(t)) return 'observability';
  if (/^(ecr|s3|efs)/.test(t)) return 'storage';
  if (/^(secretsmanager|kms|ssm_parameter)/.test(t)) return 'secrets';
  if (/^(cloudfront|route53)/.test(t)) return 'edge';
  return 'other';
}

// Single Unicode glyph per resource family. Gives each node a visual landmark
// beyond the cluster color, so a viewer can spot "the role" or "the VPC" at a
// glance without reading the label. Falls back to a generic ◻️ square for any
// unmapped type — empty-string would leave the label visually off-balance
// (the leading "icon · name" alignment would collapse).
function iconFor(resourceType: string): string {
  const t = resourceType.replace(/^aws_/, '');
  // IAM
  if (/^iam_role_policy_attachment/.test(t)) return '🔗';
  if (/^iam_role_policy/.test(t)) return '📜';
  if (/^iam_role/.test(t)) return '👤';
  if (/^iam_instance_profile/.test(t)) return '🪪';
  if (/^iam_policy_document/.test(t)) return '📜';
  if (/^caller_identity/.test(t)) return '🆔';
  // Compute
  if (/^instance/.test(t)) return '🖥️';
  if (/^eip_association/.test(t)) return '🔌';
  if (/^eip/.test(t)) return '📍';
  if (/^ami/.test(t)) return '💿';
  // Networking
  if (/^vpc_security_group/.test(t)) return '🚦';
  if (/^security_group/.test(t)) return '🛡️';
  if (/^vpc$/.test(t)) return '🏢';
  if (/^subnet/.test(t)) return '🧩';
  if (/^internet_gateway/.test(t)) return '🚪';
  if (/^route_table_association/.test(t)) return '🔗';
  if (/^route_table/.test(t)) return '🗺️';
  if (/^availability_zones/.test(t)) return '🌎';
  // Observability
  if (/^cloudwatch_metric_alarm/.test(t)) return '🚨';
  if (/^cloudwatch_log_metric_filter/.test(t)) return '🔎';
  if (/^cloudwatch_log/.test(t)) return '📋';
  if (/^cloudwatch/.test(t)) return '📊';
  if (/^sns_topic_subscription/.test(t)) return '📧';
  if (/^sns/.test(t)) return '📣';
  if (/^route53_health/.test(t)) return '💓';
  if (/^route53/.test(t)) return '🌍';
  // Storage / registry
  if (/^ecr_lifecycle/.test(t)) return '♻️';
  if (/^ecr/.test(t)) return '📦';
  if (/^s3/.test(t)) return '🪣';
  // Secrets
  if (/^secretsmanager/.test(t)) return '🔒';
  if (/^kms/.test(t)) return '🗝️';
  return '◻️';
}

// Cleaner short type label for the small caption under each node's name.
// Falls back to the snake_case type with `aws_` stripped and `_` → space.
function shortTypeLabel(resourceType: string): string {
  const t = resourceType.replace(/^aws_/, '');
  const map: Record<string, string> = {
    // IAM
    iam_role: 'IAM role',
    iam_role_policy: 'role policy',
    iam_role_policy_attachment: 'policy attachment',
    iam_instance_profile: 'instance profile',
    iam_policy_document: 'policy doc',
    caller_identity: 'AWS account',
    // Compute
    instance: 'EC2 instance',
    eip: 'Elastic IP',
    eip_association: 'EIP association',
    ami: 'AMI lookup',
    // Networking
    vpc: 'VPC',
    vpc_security_group_ingress_rule: 'ingress rule',
    vpc_security_group_egress_rule: 'egress rule',
    security_group: 'security group',
    subnet: 'subnet',
    internet_gateway: 'internet gateway',
    route_table: 'route table',
    route_table_association: 'route table assoc',
    availability_zones: 'AZ lookup',
    // Observability
    cloudwatch_log_group: 'log group',
    cloudwatch_log_metric_filter: 'log metric filter',
    cloudwatch_metric_alarm: 'metric alarm',
    sns_topic: 'SNS topic',
    sns_topic_subscription: 'SNS subscription',
    route53_health_check: 'Route 53 health check',
    // Storage / registry
    ecr_repository: 'ECR repo',
    ecr_lifecycle_policy: 'ECR lifecycle',
    // Secrets
    secretsmanager_secret: 'Secrets Manager',
  };
  return map[t] ?? t.replace(/_/g, ' ');
}

// AWS region the diagram is anchored to. Hard-coded because main.tf pins to
// us-east-1 (Route 53 health-check metrics only publish in that region).
const AWS_REGION = 'us-east-1';

// Graphviz HTML labels are XML-ish — escape the five characters that would
// break parsing. Names + short types only contain alphanumerics + _ + space
// in practice, but be defensive in case a future resource type sneaks in
// something funkier.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Inframap iterates a Go map internally, so successive runs produce DOT with
// the same statements in different orders. dot's layout is order-sensitive,
// so this leaks all the way through to the SVG and produces a noisy diff on
// every regen.
//
// We don't just sort — we fully restructure: parse the inframap output into
// nodes + edges, then emit a new DOT with category clusters, per-cluster fill
// colors, rounded box nodes, Helvetica, and orthogonal edge routing. Same DOT
// input → byte-identical SVG; node order is deterministic via sort.
function postProcessDot(dot: string, extraNodes: Set<string> = new Set()): string {
  const edgeRE = /^\s*"([^"]+)"\s*->\s*"([^"]+)"\s*;\s*$/;
  const nodeRE = /^\s*"([^"]+)"\s*\[[^\]]*\]\s*;\s*$/;

  const nodes = new Set<string>();
  const edges: Array<[string, string]> = [];

  for (const line of dot.split('\n')) {
    const e = line.match(edgeRE);
    if (e) {
      const from = e[1];
      const to = e[2];
      // edgeRE guarantees both capture groups; guard for noUncheckedIndexedAccess.
      if (from !== undefined && to !== undefined) {
        nodes.add(from);
        nodes.add(to);
        edges.push([from, to]);
      }
      continue;
    }
    const n = line.match(nodeRE);
    if (n && n[1] !== undefined) nodes.add(n[1]);
  }

  // Drift guard: edgeRE/nodeRE parse inframap's DOT line-by-line, so a future inframap
  // version emitting multi-line node attrs would silently match nothing. The extraNodes
  // union below would then paper over it — refilling `nodes` from our HCL parser — and the
  // byte-identical SVG drift check would happily pass a structurally-truncated artifact.
  // Capture the parsed count BEFORE the union and fail loudly if the parser extracted zero
  // nodes from non-empty inframap output. This floor is unreachable on healthy input (the
  // infra's IAM/SG/EC2 dependencies guarantee parsed edges/nodes); only a real format change
  // can trip it, which is exactly when a human is in the loop bumping the inframap pin.
  const parsedNodeCount = nodes.size;
  if (parsedNodeCount === 0 && extraNodes.size > 0) {
    throw new Error(
      `postProcessDot: parsed 0 nodes from non-empty inframap output, but ${extraNodes.size} ` +
        `resources were declared — the DOT node/edge regex likely no longer matches inframap's ` +
        `format (version bump?). Refusing to emit a silently-truncated diagram.`,
    );
  }

  // Inframap silently drops resources with no edges (e.g. an isolated
  // Secrets Manager secret whose only relationship is through a policy doc
  // body it can't see), which leaves whole category clusters missing from
  // the SVG. We union in `extraNodes` — sourced from our own HCL parser —
  // so every declared resource lands in its cluster, edges or no edges.
  for (const node of extraNodes) nodes.add(node);

  // Bucket nodes by category, sorted within each bucket for determinism.
  const byCategory = new Map<Category, string[]>();
  for (const node of [...nodes].sort()) {
    // node looks like "aws_instance.k3s" or "data.aws_ami.al2023"
    const cat = categorize(splitAddress(node).type);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(node);
  }

  const out: string[] = [];
  out.push('digraph G {');
  out.push(
    '  graph [rankdir=LR, splines=ortho, concentrate=true, nodesep=0.35, ranksep=0.9, pad=0.4, bgcolor=transparent, fontname="Helvetica"];',
  );
  out.push(
    '  node  [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11, margin="0.18,0.10", color="#475569", fontcolor="#0f172a"];',
  );
  out.push('  edge  [color="#94a3b8", arrowsize=0.7, penwidth=0.9];');
  out.push('');

  // Outer wrapping cluster — "AWS · us-east-1". Sets the canonical
  // "this is one cloud account in one region" framing that traditional
  // architecture diagrams have.
  out.push(`  subgraph cluster_aws {`);
  out.push(`    label=<<b>AWS</b>  ·  region ${AWS_REGION}>;`);
  out.push(`    style="rounded,filled";`);
  out.push(`    fillcolor="#f8fafc";`);
  out.push(`    color="#cbd5e1";`);
  out.push(`    fontname="Helvetica";`);
  out.push(`    fontsize=15;`);
  out.push(`    fontcolor="#0f172a";`);
  out.push(`    labeljust=l;`);
  out.push(`    margin=20;`);
  out.push('');

  const orderedCats = (
    Object.entries(CATEGORY_META) as [Category, (typeof CATEGORY_META)[Category]][]
  )
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([cat]) => cat);

  for (const cat of orderedCats) {
    const ns = byCategory.get(cat);
    if (!ns || ns.length === 0) continue;
    const meta = CATEGORY_META[cat];
    out.push(`    subgraph cluster_${cat} {`);
    out.push(`      label="${meta.label}";`);
    out.push(`      style="rounded,filled";`);
    out.push(`      fillcolor="${meta.fill}";`);
    out.push(`      color="#cbd5e1";`);
    out.push(`      fontname="Helvetica-Bold";`);
    out.push(`      fontsize=13;`);
    out.push(`      fontcolor="#334155";`);
    out.push(`      margin=14;`);
    for (const node of ns) {
      const isData = node.startsWith('data.');
      const { type: resourceType, name: resourceName } = splitAddress(node);
      const icon = iconFor(resourceType);
      const typeLabel = shortTypeLabel(resourceType);
      // Graphviz HTML-like label: icon + bold name on line 1, soft-gray short
      // type below. The `data.` lookup prefix is shown as a small badge so
      // data sources are visually distinguishable from real resources.
      const dataBadge = isData ? '<font point-size="8" color="#94a3b8">data · </font>' : '';
      const label =
        `<${icon}  ${dataBadge}<b>${escapeHtml(resourceName)}</b>` +
        `<br/><font point-size="9" color="#64748b">${escapeHtml(typeLabel)}</font>>`;
      out.push(`      "${node}" [label=${label}, fillcolor="white"];`);
    }
    out.push(`    }`);
    out.push('');
  }

  out.push(`  }`); // close cluster_aws
  out.push('');

  // Edges last, sorted for determinism.
  edges.sort(([a1, a2], [b1, b2]) => (a1 + a2).localeCompare(b1 + b2));
  for (const [from, to] of edges) {
    out.push(`  "${from}" -> "${to}";`);
  }
  out.push('}');

  return out.join('\n');
}

// Run inframap against only the resource-bearing .tf files (those with at
// least one `resource`/`data` block). inframap's HCL parser is pinned at
// v0.8.1 — the latest release, and not upgradable — which predates modern
// Terraform schema and rejects both `precondition` blocks and cross-variable
// `validation` conditions (the plan-time guards we use in variables.tf). Those
// blocks only ever live in resource-free files (variables.tf, outputs.tf),
// which contribute nothing to the resource graph, so feeding inframap a temp
// dir of just the resource-bearing files sidesteps the parser limitation while
// keeping resource-graph.svg byte-identical. See issue #265.
function renderResourceGraph(
  outFile: string,
  resourceFiles: string[],
  extraNodes: Set<string>,
): void {
  const inframapDir = mkdtempSync(join(tmpdir(), 'liner-notes-inframap-'));
  try {
    for (const file of resourceFiles) {
      copyFileSync(join(TF_DIR, file), join(inframapDir, file));
    }
    const dot = run('inframap', ['generate', '--hcl', '--raw', inframapDir]).toString();
    const svg = run(
      'docker',
      ['run', '--rm', '-i', '--platform=linux/amd64', GRAPHVIZ_IMAGE, 'dot', '-Tsvg'],
      { input: postProcessDot(dot, extraNodes) },
    );
    writeFileSync(outFile, svg);
    console.log(`  wrote ${outFile.replace(REPO_ROOT + '/', '')}`);
  } finally {
    rmSync(inframapDir, { recursive: true, force: true });
  }
}

function main(): void {
  ensureToolsAvailable();

  rmSync(PER_FILE_DIR, { recursive: true, force: true });
  mkdirSync(PER_FILE_DIR, { recursive: true });

  const files = listTfFiles();
  const blocksByFile = new Map<string, Block[]>();
  const captionsByFile = new Map<string, string | null>();

  for (const file of files) {
    const raw = readFileSync(join(TF_DIR, file), 'utf8');
    captionsByFile.set(file, extractCaption(raw));
    const src = stripComments(raw);
    blocksByFile.set(file, parseBlocks(src, file));
  }

  const allBlocks = [...blocksByFile.values()].flat();
  const declToFile = new Map<Address, string>();
  for (const b of allBlocks) declToFile.set(addressOf(b.decl), b.decl.file);
  const knownAddrs = new Set(declToFile.keys());

  console.log(`Parsed ${allBlocks.length} resources across ${files.length} files.`);

  for (const file of files) {
    const blocks = blocksByFile.get(file)!;
    if (blocks.length === 0) continue;
    // Build edges per-resource by scanning each block's body individually.
    // This is what makes the per-file diagram accurate: we know *which*
    // resource in this file references *which* other resource.
    const edges: ResourceEdge[] = [];
    for (const b of blocks) {
      const refs = findReferences(b.body, knownAddrs);
      const from = addressOf(b.decl);
      for (const to of refs) edges.push({ from, to });
    }
    const mmd = buildPerFileMermaid(
      file,
      captionsByFile.get(file) ?? null,
      blocks,
      edges,
      declToFile,
    );
    const out = join(PER_FILE_DIR, file.replace(/\.tf$/, '.mmd'));
    writeFileSync(out, mmd);
    console.log(`  wrote ${out.replace(REPO_ROOT + '/', '')}`);
  }

  console.log('\nRendering resource graph...');
  // Hand our HCL-parsed `resource` declarations to the SVG path so Inframap-
  // dropped orphans (e.g. the isolated Secrets Manager secret) still appear
  // in their category cluster. We skip data sources — they would clutter the
  // overview without adding edges, and per-file diagrams already show them.
  const declaredResourceAddrs = new Set<string>();
  for (const b of allBlocks) {
    if (b.decl.kind === 'resource') declaredResourceAddrs.add(addressOf(b.decl));
  }
  // Only hand inframap the files that actually declare resources/data; the
  // resource-free files (variables.tf, outputs.tf, backend.tf) add nothing to
  // the graph and may carry guard blocks inframap can't parse (see #265).
  const resourceFiles = files.filter((f) => (blocksByFile.get(f)?.length ?? 0) > 0);
  renderResourceGraph(join(OUT_DIR, 'resource-graph.svg'), resourceFiles, declaredResourceAddrs);

  console.log('\nInlining Mermaid sources into markdown...');
  for (const [mmdName, targets] of Object.entries(MARKDOWN_TARGETS)) {
    const mmdPath = join(OUT_DIR, `${mmdName}.mmd`);
    const body = loadMermaidBody(mmdPath);
    if (body === null) {
      console.warn(`  ⚠️  ${mmdPath} missing — skipping`);
      continue;
    }
    inlineIntoMarkdown(mmdName, body, targets);
  }

  console.log('\n✅ Diagrams regenerated.');
}

main();
