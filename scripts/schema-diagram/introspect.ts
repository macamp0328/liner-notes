// The only DB-touching module. Builds a read-only driver from env, runs the
// three introspection reads, and maps driver records into the pure row shapes
// from snapshot.ts. Keep `neo4j-driver` imported ONLY here so the offline
// `pnpm scripts:test` (which loads the pure modules) never pulls in the driver.

import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type {
  IntrospectionRaw,
  NodeTypePropertyRow,
  RelEndpointRow,
  ShowConstraintRow,
  ShowIndexRow,
} from './snapshot.js';

/** The DB couldn't be reached — likely Aura auto-paused or the node powered off.
 *  The generator treats this as "skip, write nothing, exit 0". */
export class DbUnreachableError extends Error {}

/** apoc.meta.* is not installed on the target — a real, loud failure. */
export class ApocUnavailableError extends Error {}

/** Build a read-only driver from NEO4J_URI/USER/PASSWORD. `disableLosslessIntegers`
 *  keeps 64-bit ints as plain numbers so no `Integer {low,high}` blob can leak into
 *  the JSON snapshot. An explicitly-empty password is honored (NEO4J_AUTH=none). */
export function driverFromEnv(): Driver {
  const uri = process.env['NEO4J_URI'];
  const user = process.env['NEO4J_USER'];
  const password = process.env['NEO4J_PASSWORD'];
  if (uri === undefined || user === undefined || password === undefined) {
    throw new Error('NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD must be set');
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, password), {
    disableLosslessIntegers: true,
  });
}

/** Narrowly classify connection/timeout failures as "unreachable" — auth/TLS and
 *  any other error must propagate (a broken prod credential should fail loud, not
 *  masquerade as "asleep"). */
function isUnreachable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code ?? '';
  const unreachableCodes = new Set([
    'ServiceUnavailable',
    'SessionExpired',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ECONNRESET',
  ]);
  if (unreachableCodes.has(code)) return true;
  return /ServiceUnavailable|Could not perform discovery|connection|ECONNREFUSED|ETIMEDOUT/i.test(
    e?.message ?? '',
  );
}

async function runNodeTypeProperties(session: Session): Promise<NodeTypePropertyRow[]> {
  try {
    const res = await session.run('CALL apoc.meta.nodeTypeProperties({sample: -1})');
    return res.records.map((r) => ({
      nodeLabels: r.get('nodeLabels') as string[],
      propertyName: r.get('propertyName') as string,
      propertyTypes: r.get('propertyTypes') as string[],
      mandatory: r.get('mandatory') as boolean,
    }));
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e?.code === 'Neo.ClientError.Procedure.ProcedureNotFound' ||
      /apoc\.meta/i.test(e?.message ?? '')
    ) {
      throw new ApocUnavailableError(
        'apoc.meta.nodeTypeProperties is unavailable on the target database — ' +
          'enable APOC (NEO4J_PLUGINS=["apoc"]) or point at an APOC-enabled instance.',
      );
    }
    throw err;
  }
}

async function runRelEndpoints(session: Session): Promise<RelEndpointRow[]> {
  // count(*) groups by the non-aggregated columns, giving one row per distinct
  // (from, rel, to). The count itself is dropped — endpoints are what we keep.
  const res = await session.run(
    'MATCH (a)-[r]->(b) RETURN labels(a) AS from, type(r) AS rel, labels(b) AS to, count(*) AS n',
  );
  return res.records.map((r) => ({
    from: r.get('from') as string[],
    rel: r.get('rel') as string,
    to: r.get('to') as string[],
  }));
}

async function runShowConstraints(session: Session): Promise<ShowConstraintRow[]> {
  const res = await session.run('SHOW CONSTRAINTS');
  return res.records.map((r) => ({
    name: r.get('name') as string,
    type: r.get('type') as string,
    entityType: r.get('entityType') as string,
    labelsOrTypes: r.get('labelsOrTypes') as string[] | null,
    properties: r.get('properties') as string[] | null,
  }));
}

async function runShowIndexes(session: Session): Promise<ShowIndexRow[]> {
  const res = await session.run('SHOW INDEXES');
  return res.records.map((r) => ({
    name: r.get('name') as string,
    type: r.get('type') as string,
    entityType: r.get('entityType') as string,
    labelsOrTypes: r.get('labelsOrTypes') as string[] | null,
    properties: r.get('properties') as string[] | null,
    owningConstraint: r.get('owningConstraint') as string | null,
  }));
}

export async function introspect(driver: Driver): Promise<IntrospectionRaw> {
  try {
    await driver.verifyConnectivity();
  } catch (err) {
    if (isUnreachable(err)) {
      throw new DbUnreachableError(`Neo4j unreachable: ${(err as Error).message}`);
    }
    throw err;
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const nodeTypeRows = await runNodeTypeProperties(session);
    const relRows = await runRelEndpoints(session);
    const constraintRows = await runShowConstraints(session);
    const indexRows = await runShowIndexes(session);
    return { nodeTypeRows, relRows, constraintRows, indexRows };
  } finally {
    await session.close();
  }
}
