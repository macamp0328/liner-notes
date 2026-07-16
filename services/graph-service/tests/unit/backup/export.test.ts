import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import neo4j from 'neo4j-driver';
import type { Driver, Session } from 'neo4j-driver';
import { exportGraph } from '../../../src/backup/export.js';
import type { BackupLine } from '../../../src/backup/serialize.js';

function makeNode(id: string, labels: string[], props: Record<string, unknown>) {
  return new neo4j.types.Node(neo4j.int(0), labels, props, id);
}

function makeRel(
  id: string,
  type: string,
  start: string,
  end: string,
  props: Record<string, unknown>,
) {
  return new neo4j.types.Relationship(
    neo4j.int(0),
    neo4j.int(0),
    neo4j.int(0),
    type,
    props,
    id,
    start,
    end,
  );
}

/** Async-iterable fake of a driver Result — yields records like `for await` over a real one. */
function asyncResult(key: string, values: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        yield { get: (k: string) => (k === key ? value : undefined) };
      }
    },
  };
}

function makeSession(nodes: unknown[], rels: unknown[]) {
  const runSpy = vi.fn().mockImplementation((query: string) => {
    if (query.includes('MATCH (n)')) return asyncResult('n', nodes);
    return asyncResult('r', rels);
  });
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  const session = { run: runSpy, close: closeSpy } as unknown as Session;
  return { session, runSpy, closeSpy };
}

function makeDriver(session: Session) {
  const sessionSpy = vi.fn().mockReturnValue(session);
  return { driver: { session: sessionSpy } as unknown as Driver, sessionSpy };
}

/** Collects written JSONL into parsed lines. */
function makeCollector(): { sink: Writable; lines: () => BackupLine[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as BackupLine),
  };
}

describe('exportGraph', () => {
  const nodes = [
    makeNode('n1', ['Release'], { title: 'Horses', pressingYear: neo4j.int(1975) }),
    makeNode('n2', ['Artist'], { name: 'Patti Smith' }),
    makeNode('n3', ['Artist'], { name: 'Lenny Kaye' }),
  ];
  const rels = [makeRel('r1', 'RELEASED_BY', 'n1', 'n2', { role: 'primary' })];

  it('writes metadata, nodes, rels, then a trailing manifest with counts', async () => {
    const { session } = makeSession(nodes, rels);
    const { driver } = makeDriver(session);
    const { sink, lines } = makeCollector();

    const manifest = await exportGraph(driver, sink, {
      sourceHost: 'test.host:7687',
      now: () => new Date('2026-07-16T10:00:00Z'),
    });

    const written = lines();
    expect(written).toHaveLength(1 + nodes.length + rels.length + 1);
    expect(written[0]).toEqual({
      type: 'metadata',
      formatVersion: 1,
      exportedAt: '2026-07-16T10:00:00.000Z',
      sourceHost: 'test.host:7687',
    });
    expect(written.slice(1, 4).map((l) => l.type)).toEqual(['node', 'node', 'node']);
    expect(written[4]).toEqual({
      type: 'rel',
      id: 'r1',
      relType: 'RELEASED_BY',
      start: 'n1',
      end: 'n2',
      props: { role: 'primary' },
    });
    expect(written[5]).toEqual(manifest);
    expect(manifest).toEqual({
      type: 'manifest',
      nodeCount: 3,
      relCount: 1,
      labelCounts: { Release: 1, Artist: 2 },
      relTypeCounts: { RELEASED_BY: 1 },
    });
    // node props went through the codec
    const release = written[1] as Extract<BackupLine, { type: 'node' }>;
    expect(release.props['pressingYear']).toEqual({ $t: 'int', v: '1975' });
  });

  it('requests a READ session and closes it even on failure', async () => {
    const { session, closeSpy } = makeSession(nodes, rels);
    const { driver, sessionSpy } = makeDriver(session);
    const { sink } = makeCollector();
    await exportGraph(driver, sink);
    expect(sessionSpy).toHaveBeenCalledWith({ defaultAccessMode: neo4j.session.READ });
    expect(closeSpy).toHaveBeenCalledTimes(1);

    const failing = {
      run: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const { driver: failingDriver } = makeDriver(failing);
    await expect(exportGraph(failingDriver, makeCollector().sink)).rejects.toThrow('boom');
    expect((failing as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(
      1,
    );
  });

  it('does not end the sink (caller owns the stream lifecycle)', async () => {
    const { session } = makeSession(nodes, rels);
    const { driver } = makeDriver(session);
    const { sink } = makeCollector();
    await exportGraph(driver, sink);
    expect(sink.writableEnded).toBe(false);
  });

  it('respects backpressure — waits for drain on a slow sink and loses nothing', async () => {
    const { session } = makeSession(nodes, rels);
    const { driver } = makeDriver(session);
    const chunks: string[] = [];
    // highWaterMark 1 forces write() to return false on every chunk; the async callback
    // makes exportGraph actually await the 'drain' event before continuing.
    const slowSink = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString());
        setImmediate(cb);
      },
    });
    const manifest = await exportGraph(driver, slowSink);
    const written = chunks
      .join('')
      .split('\n')
      .filter((l) => l !== '');
    expect(written).toHaveLength(1 + nodes.length + rels.length + 1);
    expect(manifest.nodeCount).toBe(3);
  });

  it('handles an empty graph — manifest reports zeros', async () => {
    const { session } = makeSession([], []);
    const { driver } = makeDriver(session);
    const { sink, lines } = makeCollector();
    const manifest = await exportGraph(driver, sink);
    expect(manifest).toEqual({
      type: 'manifest',
      nodeCount: 0,
      relCount: 0,
      labelCounts: {},
      relTypeCounts: {},
    });
    expect(lines().map((l) => l.type)).toEqual(['metadata', 'manifest']);
  });
});
