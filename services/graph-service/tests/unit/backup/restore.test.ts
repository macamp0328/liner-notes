import { describe, it, expect, vi } from 'vitest';
import type { Driver, Session } from 'neo4j-driver';
import {
  escapeCypherIdentifier,
  parseBackupLine,
  collectBackup,
  groupNodesByLabelSet,
  groupRelsByType,
  restoreGraph,
  splitJsonlLines,
  verifyRestore,
  countGraph,
  RESTORE_TEMP_INDEX,
  type ParsedBackup,
} from '../../../src/backup/restore.js';
import type { ManifestLine, NodeLine, RelLine } from '../../../src/backup/serialize.js';

const META =
  '{"type":"metadata","formatVersion":1,"exportedAt":"2026-07-16T10:00:00Z","sourceHost":"h"}';
const MANIFEST =
  '{"type":"manifest","nodeCount":1,"relCount":0,"labelCounts":{"Release":1},"relTypeCounts":{}}';
const NODE = '{"type":"node","id":"n1","labels":["Release"],"props":{"title":"Horses"}}';
const REL = '{"type":"rel","id":"r1","relType":"ON_LABEL","start":"n1","end":"n2","props":{}}';

function nodeLine(id: string, labels: string[], props: Record<string, unknown> = {}): NodeLine {
  return { type: 'node', id, labels, props: props as NodeLine['props'] };
}

function relLine(id: string, relType: string, start: string, end: string): RelLine {
  return { type: 'rel', id, relType, start, end, props: {} };
}

describe('escapeCypherIdentifier', () => {
  it('backtick-quotes plain names', () => {
    expect(escapeCypherIdentifier('Release')).toBe('`Release`');
    expect(escapeCypherIdentifier('ODD LABEL')).toBe('`ODD LABEL`');
  });

  it('neutralizes backtick injection by doubling embedded backticks', () => {
    // A hostile label trying to break out of the quoting and append a clause
    const hostile = 'X` ) DETACH DELETE n //';
    expect(escapeCypherIdentifier(hostile)).toBe('`X`` ) DETACH DELETE n //`');
  });
});

describe('parseBackupLine', () => {
  it('parses each line type', () => {
    expect(parseBackupLine(META, 1).type).toBe('metadata');
    expect(parseBackupLine(NODE, 2).type).toBe('node');
    expect(parseBackupLine(REL, 3).type).toBe('rel');
    expect(parseBackupLine(MANIFEST, 4).type).toBe('manifest');
  });

  it('rejects malformed input with the line number', () => {
    expect(() => parseBackupLine('not json', 7)).toThrow(/Line 7: not valid JSON/);
    expect(() => parseBackupLine('{"noType":1}', 2)).toThrow(/missing "type"/);
    expect(() => parseBackupLine('{"type":"wat"}', 3)).toThrow(/unknown line type "wat"/);
    expect(() => parseBackupLine('{"type":"node","labels":[],"props":{}}', 4)).toThrow(
      /missing string "id"/,
    );
    expect(() =>
      parseBackupLine('{"type":"node","id":"n","labels":["A",7],"props":{}}', 8),
    ).toThrow(/Line 8: .*"labels" array of strings/);
    expect(() =>
      parseBackupLine('{"type":"rel","id":"r","relType":"T","start":"a","props":{}}', 5),
    ).toThrow(/missing string "end"/);
    expect(() => parseBackupLine('{"type":"manifest","nodeCount":"x","relCount":0}', 6)).toThrow(
      /missing numeric counts/,
    );
  });

  it('rejects a format version this build cannot read', () => {
    const future = META.replace('"formatVersion":1', '"formatVersion":2');
    expect(() => parseBackupLine(future, 1)).toThrow(/unsupported formatVersion 2/);
  });
});

describe('collectBackup', () => {
  it('collects a well-formed file, ignoring blank lines', async () => {
    const backup = await collectBackup([META, '', NODE, MANIFEST]);
    expect(backup.metadata.sourceHost).toBe('h');
    expect(backup.nodes).toHaveLength(1);
    expect(backup.rels).toHaveLength(0);
    expect(backup.manifest.nodeCount).toBe(1);
  });

  it('refuses a truncated file (no trailing manifest)', async () => {
    await expect(collectBackup([META, NODE])).rejects.toThrow(/truncated/);
  });

  it('refuses a file that does not start with metadata, an empty file, and trailing content', async () => {
    await expect(collectBackup([NODE, MANIFEST])).rejects.toThrow(/expected a metadata line first/);
    await expect(collectBackup([])).rejects.toThrow(/Empty file/);
    await expect(collectBackup([META, MANIFEST, NODE])).rejects.toThrow(
      /content after the manifest/,
    );
    await expect(collectBackup([META, META, MANIFEST])).rejects.toThrow(/duplicate metadata/);
  });
});

describe('splitJsonlLines', () => {
  async function collect(chunks: (string | Buffer)[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of splitJsonlLines(chunks)) out.push(line);
    return out;
  }

  it('splits on \\n only — U+2028/U+2029 and bare \\r never break a record', async () => {
    // The exact failure a real prod backup hit: readline treats U+2028 as a terminator.
    const record = '{"profile":"drums\u2028guitar\u2029bass\rmore"}';
    expect(await collect([record + '\n', 'tail'])).toEqual([record, 'tail']);
  });

  it('reassembles lines split across chunk boundaries, including multi-byte UTF-8', async () => {
    const line = '{"name":"Björk — 🎵"}';
    const bytes = Buffer.from(line + '\n{"x":1}\n', 'utf8');
    // cut mid-emoji (the 🎵 is 4 bytes) so a naive chunk.toString() would corrupt
    const cut = bytes.indexOf(Buffer.from('🎵', 'utf8')) + 2;
    const lines = await collect([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(lines).toEqual([line, '{"x":1}']);
  });

  it('yields a final unterminated line and nothing for empty input', async () => {
    expect(await collect(['no trailing newline'])).toEqual(['no trailing newline']);
    expect(await collect([])).toEqual([]);
    expect(await collect(['a\nb\n'])).toEqual(['a', 'b']);
  });
});

describe('grouping', () => {
  it('groups nodes by sorted label set — order variants collapse, zero-label kept', () => {
    const groups = groupNodesByLabelSet([
      nodeLine('a', ['Musician', 'Artist']),
      nodeLine('b', ['Artist', 'Musician']),
      nodeLine('c', ['Artist']),
      nodeLine('d', []),
    ]);
    const byKey = new Map(groups.map((g) => [g.labels.join(':'), g.nodes.length]));
    expect(byKey.get('Artist:Musician')).toBe(2);
    expect(byKey.get('Artist')).toBe(1);
    expect(byKey.get('')).toBe(1);
    expect(groups).toHaveLength(3);
  });

  it('groups rels by type', () => {
    const groups = groupRelsByType([
      relLine('1', 'ON_LABEL', 'a', 'b'),
      relLine('2', 'IN_GENRE', 'a', 'c'),
      relLine('3', 'ON_LABEL', 'b', 'c'),
    ]);
    expect(groups.get('ON_LABEL')).toHaveLength(2);
    expect(groups.get('IN_GENRE')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// restoreGraph against a scripted mock session
// ---------------------------------------------------------------------------

type RunCall = {
  query: string;
  params?: { rows: { id?: string; props: Record<string, unknown> }[] } | undefined;
};

function makeReplayHarness(opts: { relsCreatedPerBatch?: (batchLen: number) => number } = {}) {
  const calls: RunCall[] = [];
  let cleanupServed = false;
  const runSpy = vi.fn().mockImplementation((query: string, params?: RunCall['params']) => {
    calls.push({ query, params });
    if (query.includes('RETURN count(n) AS cleaned')) {
      const cleaned = cleanupServed ? 0 : 3;
      cleanupServed = true;
      return Promise.resolve({
        records: [{ get: () => ({ toNumber: () => cleaned }) }],
        summary: { counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0 }) } },
      });
    }
    const rows = params?.rows ?? [];
    const isRelBatch = query.includes('MATCH (a:');
    return Promise.resolve({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: isRelBatch ? 0 : rows.length,
            relationshipsCreated: isRelBatch
              ? (opts.relsCreatedPerBatch?.(rows.length) ?? rows.length)
              : 0,
          }),
        },
      },
    });
  });
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  const session = { run: runSpy, close: closeSpy } as unknown as Session;
  const driver = { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
  return { driver, calls, closeSpy };
}

function makeBackup(nodes: NodeLine[], rels: RelLine[]): ParsedBackup {
  return {
    metadata: { type: 'metadata', formatVersion: 1, exportedAt: 'x', sourceHost: 'h' },
    nodes,
    rels,
    manifest: {
      type: 'manifest',
      nodeCount: nodes.length,
      relCount: rels.length,
      labelCounts: {},
      relTypeCounts: {},
    },
  };
}

describe('restoreGraph', () => {
  it('replays nodes then rels with escaped identifiers, decoded props, and cleanup', async () => {
    const { driver, calls, closeSpy } = makeReplayHarness();
    const backup = makeBackup(
      [
        nodeLine('n1', ['Release'], { year: { $t: 'int', v: '1975' } }),
        nodeLine('n2', ['Artist', 'Musician']),
        nodeLine('n3', []),
      ],
      [relLine('r1', 'RELEASED_BY', 'n1', 'n2')],
    );

    const result = await restoreGraph(driver, backup);
    expect(result.nodesCreated).toBe(3);
    expect(result.relsCreated).toBe(1);
    expect(result.danglingRelsByType).toEqual({});

    const queries = calls.map((c) => c.query);
    expect(queries[0]).toContain(`CREATE INDEX ${RESTORE_TEMP_INDEX} IF NOT EXISTS`);
    const nodeQueries = queries.filter((q) => q.includes('CREATE (n:'));
    expect(nodeQueries.some((q) => q.includes('CREATE (n:`_LnRestore`:`Release`)'))).toBe(true);
    expect(nodeQueries.some((q) => q.includes('CREATE (n:`_LnRestore`:`Artist`:`Musician`)'))).toBe(
      true,
    );
    // zero-label node still gets the temp label so the rel MATCH can find it
    expect(nodeQueries.some((q) => q.trim().includes('CREATE (n:`_LnRestore`)'))).toBe(true);
    expect(queries.some((q) => q.includes('CREATE (a)-[r:`RELEASED_BY`]->(b)'))).toBe(true);
    expect(queries.at(-1)).toBe(`DROP INDEX ${RESTORE_TEMP_INDEX} IF EXISTS`);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // props were DECODED before being parameterized — the driver gets a real Integer
    const releaseBatch = calls.find((c) => c.query.includes(':`Release`)'));
    const yearParam = releaseBatch?.params?.rows[0]?.props['year'] as { toNumber(): number };
    expect(typeof yearParam.toNumber).toBe('function');
    expect(yearParam.toNumber()).toBe(1975);
  });

  it('splits batches by batchSize', async () => {
    const { driver, calls } = makeReplayHarness();
    const nodes = Array.from({ length: 5 }, (_, i) => nodeLine(`n${i}`, ['Track']));
    await restoreGraph(driver, makeBackup(nodes, []), { batchSize: 2 });
    const trackBatches = calls.filter((c) => c.query.includes(':`Track`)'));
    expect(trackBatches.map((c) => c.params?.rows.length)).toEqual([2, 2, 1]);
  });

  it('counts dangling rels per type when a batch creates fewer than its rows', async () => {
    const { driver } = makeReplayHarness({ relsCreatedPerBatch: (n) => n - 1 });
    const backup = makeBackup(
      [nodeLine('n1', ['A']), nodeLine('n2', ['A'])],
      [
        relLine('r1', 'ON_LABEL', 'n1', 'n2'),
        relLine('r2', 'ON_LABEL', 'n1', 'missing'),
        relLine('r3', 'IN_GENRE', 'n1', 'gone'),
      ],
    );
    const result = await restoreGraph(driver, backup);
    expect(result.danglingRelsByType).toEqual({ ON_LABEL: 1, IN_GENRE: 1 });
    expect(result.relsCreated).toBe(1);
  });
});

describe('countGraph', () => {
  it('unwraps neo4j Integer counts', async () => {
    const session = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            get: (key: string) =>
              key === 'nodes' ? { toNumber: () => 12 } : { toNumber: () => 34 },
          },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
    expect(await countGraph(driver)).toEqual({ nodes: 12, rels: 34 });
  });
});

describe('verifyRestore', () => {
  const manifest: ManifestLine = {
    type: 'manifest',
    nodeCount: 10,
    relCount: 20,
    labelCounts: {},
    relTypeCounts: {},
  };

  it('passes when everything lines up', () => {
    expect(
      verifyRestore(
        manifest,
        { nodesCreated: 10, relsCreated: 20, danglingRelsByType: {} },
        { nodes: 10, rels: 20 },
      ),
    ).toEqual([]);
  });

  it('names every mismatch and every dangling-rel type', () => {
    const problems = verifyRestore(
      manifest,
      { nodesCreated: 9, relsCreated: 18, danglingRelsByType: { ON_LABEL: 2 } },
      { nodes: 9, rels: 18 },
    );
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toContain('created 9 nodes but manifest says 10');
    expect(problems.join('\n')).toContain('2 dangling ON_LABEL rel(s)');
  });
});
