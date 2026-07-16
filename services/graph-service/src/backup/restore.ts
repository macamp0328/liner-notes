/**
 * restore.ts — replays a #104 backup file into an (empty) Neo4j target. The pure parsing/
 * planning pieces and the driver-replaying engine live here so both the operator script
 * (scripts/backup-restore.ts) and the integration round-trip test share one implementation.
 *
 * REPLAY ORDER: nodes first, each stamped with a temp `_LnRestore` label + `_lnBackupId`
 * property (the file's elementId — an intra-file key only); then rels matched on that key;
 * then a cleanup loop strips the temp label/property and drops the temp index. The temp label
 * is always added so even zero-label nodes stay matchable.
 *
 * SECURITY: labels and relationship types cannot be Cypher parameters, so they are interpolated
 * into query strings — every interpolated identifier goes through {@link escapeCypherIdentifier}
 * (backtick-quote, double embedded backticks) so a corrupt or hostile backup file cannot inject
 * Cypher.
 *
 * DANGLING RELS: a read-committed export taken during concurrent writes can contain rels whose
 * endpoints missed the node scan. Those CREATE-via-MATCH batches simply create fewer rels than
 * rows; the shortfall is counted per type and reported instead of crashing — the caller's
 * manifest diff then surfaces it as a verification failure the operator can judge.
 *
 * MEMORY: the whole backup is grouped in memory (label sets / rel types can't be parameterized,
 * so batches must be homogeneous). Fine at this graph's scale on an operator machine; a two-pass
 * streaming rewrite is the escape hatch if the graph ever grows 10x.
 */
import type { Driver } from 'neo4j-driver';
import {
  FORMAT_VERSION,
  decodeProps,
  labelSetKey,
  type BackupLine,
  type ManifestLine,
  type MetadataLine,
  type NodeLine,
  type RelLine,
} from './serialize.js';

export const RESTORE_TEMP_LABEL = '_LnRestore';
export const RESTORE_TEMP_PROP = '_lnBackupId';
export const RESTORE_TEMP_INDEX = 'ln_restore_tmp';

export interface ParsedBackup {
  metadata: MetadataLine;
  nodes: NodeLine[];
  rels: RelLine[];
  manifest: ManifestLine;
}

/** Backtick-quotes a label / relationship-type for safe interpolation into Cypher. */
export function escapeCypherIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses and shape-checks one JSONL line. Throws with the line number on anything malformed. */
export function parseBackupLine(line: string, lineNo: number): BackupLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Line ${lineNo}: not valid JSON`);
  }
  if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
    throw new Error(`Line ${lineNo}: missing "type" discriminator`);
  }
  const type = parsed['type'];
  const fail = (why: string): never => {
    throw new Error(`Line ${lineNo}: malformed "${type}" line — ${why}`);
  };
  switch (type) {
    case 'metadata': {
      if (parsed['formatVersion'] !== FORMAT_VERSION) {
        throw new Error(
          `Line ${lineNo}: unsupported formatVersion ${String(parsed['formatVersion'])} ` +
            `(this build reads version ${FORMAT_VERSION})`,
        );
      }
      return parsed as unknown as MetadataLine;
    }
    case 'node': {
      if (typeof parsed['id'] !== 'string') fail('missing string "id"');
      const labels = parsed['labels'];
      // Element types are checked here so a corrupt file fails fast with the line number,
      // not later inside grouping/escaping with the context lost.
      if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string')) {
        fail('missing "labels" array of strings');
      }
      if (!isRecord(parsed['props'])) fail('missing "props" object');
      return parsed as unknown as NodeLine;
    }
    case 'rel': {
      for (const field of ['id', 'relType', 'start', 'end']) {
        // eslint-disable-next-line security/detect-object-injection -- `field` is a literal from the array above, never input data
        if (typeof parsed[field] !== 'string') fail(`missing string "${field}"`);
      }
      if (!isRecord(parsed['props'])) fail('missing "props" object');
      return parsed as unknown as RelLine;
    }
    case 'manifest': {
      if (typeof parsed['nodeCount'] !== 'number' || typeof parsed['relCount'] !== 'number') {
        fail('missing numeric counts');
      }
      return parsed as unknown as ManifestLine;
    }
    default:
      throw new Error(`Line ${lineNo}: unknown line type "${type}"`);
  }
}

/**
 * Splits a byte/text stream into lines on `\n` ONLY — never on `\r` alone or the Unicode
 * LINE/PARAGRAPH SEPARATORS (U+2028/U+2029), which Node's readline treats as terminators.
 * That readline behaviour shattered a real prod backup record (a Discogs profile containing a
 * raw U+2028, which JSON.stringify legally leaves unescaped) into unparseable fragments — this
 * splitter's semantics match how the export writes: one record per `\n`. Buffer chunks are
 * decoded with a streaming TextDecoder so a multi-byte UTF-8 character split across chunk
 * boundaries never corrupts. A trailing `\r` (CRLF file) is left for collectBackup's trim.
 */
export async function* splitJsonlLines(
  source: AsyncIterable<string | Buffer> | Iterable<string | Buffer>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt !== -1) {
      yield buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode(); // flush any dangling multi-byte sequence
  if (buffer !== '') yield buffer;
}

/**
 * Collects a full backup from an (async) line iterable, enforcing the strict file shape:
 * metadata first, a trailing manifest (its absence means the export was truncated mid-write),
 * and nothing after the manifest. Blank lines are ignored.
 */
export async function collectBackup(
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<ParsedBackup> {
  let metadata: MetadataLine | null = null;
  let manifest: ManifestLine | null = null;
  const nodes: NodeLine[] = [];
  const rels: RelLine[] = [];
  let lineNo = 0;
  for await (const rawLine of lines) {
    lineNo++;
    const line = rawLine.trim();
    if (line === '') continue;
    if (manifest !== null) throw new Error(`Line ${lineNo}: content after the manifest line`);
    const parsed = parseBackupLine(line, lineNo);
    if (parsed.type === 'metadata') {
      if (metadata !== null) throw new Error(`Line ${lineNo}: duplicate metadata line`);
      metadata = parsed;
      continue;
    }
    if (metadata === null) {
      throw new Error(`Line ${lineNo}: expected a metadata line first — is this a backup file?`);
    }
    if (parsed.type === 'node') nodes.push(parsed);
    else if (parsed.type === 'rel') rels.push(parsed);
    else manifest = parsed;
  }
  if (metadata === null) throw new Error('Empty file — no metadata line');
  if (manifest === null) {
    throw new Error(
      'No trailing manifest line — the backup file is truncated; refusing to restore',
    );
  }
  return { metadata, nodes, rels, manifest };
}

export interface LabelGroup {
  labels: string[];
  nodes: NodeLine[];
}

/** Groups nodes by sorted label set so each CREATE batch is label-homogeneous. */
export function groupNodesByLabelSet(nodes: NodeLine[]): LabelGroup[] {
  const groups = new Map<string, LabelGroup>();
  for (const node of nodes) {
    const labels = [...node.labels].sort();
    const key = labelSetKey(labels);
    let group = groups.get(key);
    if (group === undefined) {
      group = { labels, nodes: [] };
      groups.set(key, group);
    }
    group.nodes.push(node);
  }
  return [...groups.values()];
}

export function groupRelsByType(rels: RelLine[]): Map<string, RelLine[]> {
  const groups = new Map<string, RelLine[]>();
  for (const rel of rels) {
    const list = groups.get(rel.relType);
    if (list === undefined) groups.set(rel.relType, [rel]);
    else list.push(rel);
  }
  return groups;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface RestoreResult {
  nodesCreated: number;
  relsCreated: number;
  /** Rels skipped because an endpoint was missing from the dump (read-committed export). */
  danglingRelsByType: Record<string, number>;
}

export interface RestoreOptions {
  batchSize?: number;
  onProgress?: (message: string) => void;
}

/**
 * Replays a parsed backup into the target. The target should be empty (the operator script
 * enforces that) — replay is CREATE-based, so restoring on top of existing data duplicates it.
 */
export async function restoreGraph(
  driver: Driver,
  backup: ParsedBackup,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const batchSize = options.batchSize ?? 500;
  const progress = options.onProgress ?? ((): void => {});
  const tempLabel = escapeCypherIdentifier(RESTORE_TEMP_LABEL);
  const session = driver.session();
  try {
    await session.run(
      `CREATE INDEX ${RESTORE_TEMP_INDEX} IF NOT EXISTS ` +
        `FOR (n:${tempLabel}) ON (n.${RESTORE_TEMP_PROP})`,
    );

    let nodesCreated = 0;
    for (const group of groupNodesByLabelSet(backup.nodes)) {
      const labelCypher = [tempLabel, ...group.labels.map(escapeCypherIdentifier)].join(':');
      const query =
        `UNWIND $rows AS row CREATE (n:${labelCypher}) ` +
        `SET n = row.props, n.${RESTORE_TEMP_PROP} = row.id`;
      for (const batch of chunk(group.nodes, batchSize)) {
        const rows = batch.map((node) => ({ id: node.id, props: decodeProps(node.props) }));
        const result = await session.run(query, { rows });
        nodesCreated += result.summary.counters.updates().nodesCreated;
      }
      progress(`nodes: ${nodesCreated}/${backup.nodes.length} (${labelSetKey(group.labels)})`);
    }

    let relsCreated = 0;
    const danglingRelsByType = new Map<string, number>();
    for (const [relType, rels] of groupRelsByType(backup.rels)) {
      const query =
        `UNWIND $rows AS row ` +
        `MATCH (a:${tempLabel} {${RESTORE_TEMP_PROP}: row.start}) ` +
        `MATCH (b:${tempLabel} {${RESTORE_TEMP_PROP}: row.end}) ` +
        `CREATE (a)-[r:${escapeCypherIdentifier(relType)}]->(b) SET r = row.props`;
      for (const batch of chunk(rels, batchSize)) {
        const rows = batch.map((rel) => ({
          start: rel.start,
          end: rel.end,
          props: decodeProps(rel.props),
        }));
        const result = await session.run(query, { rows });
        const created = result.summary.counters.updates().relationshipsCreated;
        relsCreated += created;
        if (created < batch.length) {
          danglingRelsByType.set(
            relType,
            (danglingRelsByType.get(relType) ?? 0) + (batch.length - created),
          );
        }
      }
      progress(`rels: ${relsCreated}/${backup.rels.length} (${relType})`);
    }

    // Strip the temp label/property in bounded batches so the cleanup never builds one huge
    // transaction, then drop the temp index.
    let cleaned = 1;
    while (cleaned > 0) {
      const result = await session.run(
        `MATCH (n:${tempLabel}) WITH n LIMIT 5000 ` +
          `REMOVE n.${RESTORE_TEMP_PROP}, n:${tempLabel} RETURN count(n) AS cleaned`,
      );
      const raw = result.records[0]?.get('cleaned') as { toNumber?: () => number } | number;
      cleaned = typeof raw === 'number' ? raw : (raw?.toNumber?.() ?? 0);
    }
    await session.run(`DROP INDEX ${RESTORE_TEMP_INDEX} IF EXISTS`);

    return {
      nodesCreated,
      relsCreated,
      danglingRelsByType: Object.fromEntries(danglingRelsByType),
    };
  } finally {
    await session.close();
  }
}

/** Total node/rel counts for restore verification (also used by the round-trip test). */
export async function countGraph(driver: Driver): Promise<{ nodes: number; rels: number }> {
  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH (n) WITH count(n) AS nodes OPTIONAL MATCH ()-[r]->() RETURN nodes, count(r) AS rels',
    );
    const record = result.records[0];
    const toNum = (raw: unknown): number =>
      typeof raw === 'number' ? raw : ((raw as { toNumber?: () => number })?.toNumber?.() ?? 0);
    return { nodes: toNum(record?.get('nodes')), rels: toNum(record?.get('rels')) };
  } finally {
    await session.close();
  }
}

/** Pure manifest-vs-outcome diff — the operator script exits 1 when this is non-empty. */
export function verifyRestore(
  manifest: ManifestLine,
  result: RestoreResult,
  counts: { nodes: number; rels: number },
): string[] {
  const problems: string[] = [];
  if (result.nodesCreated !== manifest.nodeCount) {
    problems.push(`created ${result.nodesCreated} nodes but manifest says ${manifest.nodeCount}`);
  }
  if (result.relsCreated !== manifest.relCount) {
    problems.push(`created ${result.relsCreated} rels but manifest says ${manifest.relCount}`);
  }
  if (counts.nodes !== manifest.nodeCount) {
    problems.push(`target now has ${counts.nodes} nodes but manifest says ${manifest.nodeCount}`);
  }
  if (counts.rels !== manifest.relCount) {
    problems.push(`target now has ${counts.rels} rels but manifest says ${manifest.relCount}`);
  }
  for (const [relType, dangling] of Object.entries(result.danglingRelsByType)) {
    problems.push(
      `${dangling} dangling ${relType} rel(s) skipped — endpoint missing from the dump`,
    );
  }
  return problems;
}
