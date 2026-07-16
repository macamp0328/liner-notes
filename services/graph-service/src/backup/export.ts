/**
 * export.ts — streams the full graph (every node, relationship, and property) to a Writable
 * as JSONL (issue #104). Sink-agnostic on purpose: prod pipes into gzip → S3, the integration
 * round-trip test passes an in-memory collector, and no S3 client ever appears here.
 *
 * MEMORY: results are consumed with `for await` — NEVER `await result`, which eagerly buffers
 * every record. The async iterator drives Bolt PULL flow control (default fetchSize 1000), so
 * peak memory is ~one fetch batch regardless of graph size — safe on both the CronJob pod's
 * 256Mi limit and Aura Free.
 *
 * CONSISTENCY: Neo4j is read-committed, not snapshot-isolated — the node scan and the rel scan
 * see concurrent writes. The CronJob entrypoint gates on a running reload before calling this,
 * and the restore side tolerates (and reports) rels whose endpoints are missing from the dump.
 *
 * FILE SHAPE (strict order): one `metadata` line → every `node` line → every `rel` line → a
 * trailing `manifest` line with counts. The trailing manifest doubles as a truncation guard —
 * a file without one is by definition incomplete and the restore script refuses it.
 */
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import neo4j from 'neo4j-driver';
import type { Driver, Node, Relationship } from 'neo4j-driver';
import {
  FORMAT_VERSION,
  encodeNode,
  encodeRelationship,
  labelSetKey,
  type BackupLine,
  type ManifestLine,
} from './serialize.js';

export interface ExportOptions {
  /** Recorded in the metadata line so a restore preflight can show where the dump came from. */
  sourceHost?: string;
  now?: () => Date;
}

async function writeLine(sink: Writable, line: BackupLine): Promise<void> {
  if (!sink.write(`${JSON.stringify(line)}\n`)) {
    await once(sink, 'drain');
  }
}

/**
 * Streams the whole graph to `sink` and resolves with the manifest it wrote as the final line.
 * Does NOT end the sink — the caller owns the stream lifecycle (it may be mid-pipeline).
 */
export async function exportGraph(
  driver: Driver,
  sink: Writable,
  options: ExportOptions = {},
): Promise<ManifestLine> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    await writeLine(sink, {
      type: 'metadata',
      formatVersion: FORMAT_VERSION,
      exportedAt: (options.now?.() ?? new Date()).toISOString(),
      sourceHost: options.sourceHost ?? 'unknown',
    });

    const labelCounts = new Map<string, number>();
    let nodeCount = 0;
    for await (const record of session.run('MATCH (n) RETURN n')) {
      const node = record.get('n') as Node;
      await writeLine(sink, encodeNode(node));
      nodeCount++;
      const key = labelSetKey([...node.labels]);
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }

    const relTypeCounts = new Map<string, number>();
    let relCount = 0;
    for await (const record of session.run('MATCH ()-[r]->() RETURN r')) {
      const rel = record.get('r') as Relationship;
      await writeLine(sink, encodeRelationship(rel));
      relCount++;
      relTypeCounts.set(rel.type, (relTypeCounts.get(rel.type) ?? 0) + 1);
    }

    const manifest: ManifestLine = {
      type: 'manifest',
      nodeCount,
      relCount,
      labelCounts: Object.fromEntries(labelCounts),
      relTypeCounts: Object.fromEntries(relTypeCounts),
    };
    await writeLine(sink, manifest);
    return manifest;
  } finally {
    await session.close();
  }
}
