import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocsServer } from '../../../src/server.js';

// Guards the CLAUDE.md claim "Integration: 100% of API routes covered". The route
// table is read live from the real builder (buildDocsServer registers the same
// route plugins as buildServer but skips the Neo4j onReady hook, so this needs no
// DB), and the "covered" set is DERIVED from the integration test sources — every
// `/api/...` literal they reference. A route counts as covered only when some
// integration test mentions its path, so the guard is self-maintaining: add a route
// without an integration test and the forward assertion fails naming it.
//
// Matching is path-level, not method-level: the HTTP method isn't reliably
// extractable from test source (the admin suite drives requests from a {method,url}[]
// via it.each). No registered path currently carries two methods, so nothing is lost;
// a hypothetical second method added to an existing path would not be flagged.

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

// Captures inline string literals and `${...}` template literals; the trailing query
// string is stripped after capture. The char class deliberately stops at quotes,
// backticks, commas, and parens so each literal is captured cleanly.
const API_PATH_RE = /\/api\/[A-Za-z0-9_\-.\/:{}$%?=&]*/g;

// Paths an integration test hits ON PURPOSE that are NOT registered routes — e.g. a
// future test asserting the global 404 handler against an unregistered path. Empty
// today (validated: every referenced literal maps to a real route). Add an entry here
// only for a deliberately-unregistered path, so the reverse check stays a real typo
// guard rather than a rubber stamp.
const KNOWN_UNREGISTERED_PATHS = new Set<string>([]);

const THIS_FILE = fileURLToPath(import.meta.url);
const INTEGRATION_ROOT = join(dirname(THIS_FILE), '..');

interface RouteOperation {
  method: string;
  path: string;
}

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (entry.name.endsWith('.test.ts') && full !== THIS_FILE) {
      files.push(full);
    }
  }
  return files;
}

function stripQuery(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

function extractApiPaths(source: string): string[] {
  return (source.match(API_PATH_RE) ?? []).map(stripQuery);
}

function segments(path: string): string[] {
  return stripQuery(path)
    .split('/')
    .filter((s) => s.length > 0);
}

// A wildcard segment matches any single segment: route params ({name} / :name) and a
// test segment carrying a `${...}` template interpolation.
function isWildcard(segment: string): boolean {
  return segment.startsWith('{') || segment.startsWith(':') || segment.includes('${');
}

function pathsMatch(routePath: string, testPath: string): boolean {
  const route = segments(routePath);
  const test = segments(testPath);
  if (route.length !== test.length) return false;
  return route.every((routeSeg, i) => {
    const testSeg = test[i];
    if (isWildcard(routeSeg)) return true;
    return testSeg !== undefined && (isWildcard(testSeg) || routeSeg === testSeg);
  });
}

describe('integration route coverage guard', () => {
  let app: FastifyInstance;
  let registeredRoutes: RouteOperation[];
  let exercisedPaths: string[];

  beforeAll(async () => {
    app = await buildDocsServer();
    await app.ready();
    const spec = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    registeredRoutes = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((key) => HTTP_VERBS.has(key.toLowerCase()))
        .map((method) => ({ method: method.toUpperCase(), path })),
    );

    const exercised = new Set<string>();
    for (const file of collectTestFiles(INTEGRATION_ROOT)) {
      for (const apiPath of extractApiPaths(readFileSync(file, 'utf8'))) {
        exercised.add(apiPath);
      }
    }
    exercisedPaths = [...exercised];
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers at least the known API surface', () => {
    // A floor that fails loudly if buildDocsServer/swagger ever stops surfacing the
    // route table (e.g. a refactor that hides routes) — otherwise an empty route list
    // would make the forward check vacuously pass.
    expect(registeredRoutes.length).toBeGreaterThan(40);
    expect(exercisedPaths.length).toBeGreaterThan(0);
  });

  it('every registered route is exercised by an integration test', () => {
    const uncovered = registeredRoutes.filter(
      (route) => !exercisedPaths.some((testPath) => pathsMatch(route.path, testPath)),
    );
    const message =
      `No integration test references ${uncovered.length} registered route(s):\n` +
      uncovered.map((r) => `  ${r.method} ${r.path}`).join('\n') +
      `\n\nAdd an integration test that hits each path, or update the ` +
      `"Integration: 100% of API routes covered" claim in services/graph-service/CLAUDE.md.`;
    expect(uncovered, message).toHaveLength(0);
  });

  it('every API path referenced by an integration test maps to a registered route', () => {
    const unmatched = exercisedPaths.filter(
      (testPath) =>
        !KNOWN_UNREGISTERED_PATHS.has(testPath) &&
        !registeredRoutes.some((route) => pathsMatch(route.path, testPath)),
    );
    const message =
      `${unmatched.length} API path(s) referenced by integration tests match no registered route ` +
      `(likely a typo or a renamed route):\n` +
      unmatched.map((p) => `  ${p}`).join('\n') +
      `\n\nFix the test URL, or add the path to KNOWN_UNREGISTERED_PATHS if the test ` +
      `hits an unregistered path on purpose.`;
    expect(unmatched, message).toHaveLength(0);
  });
});
