// Pure self-validation for the emitted Insomnia v5 collection: parse the YAML
// back and assert every import-critical invariant (folder/request structure,
// unique deterministic ids, secured-op bearer inheritance, the disarmed reset).
//
// Extracted from generate.ts so the rules — verified against Insomnia's
// import-v5-parser.ts — are unit-testable on their own (the changelog suite's
// lib/command split). generate.ts stays a thin command script that reads the
// spec, builds via openapi-to-insomnia, calls validateDocument, and writes.

import { parse } from 'yaml';
import {
  ADMIN_TOKEN_TEMPLATE,
  BASE_URL_TEMPLATE,
  LOCAL_BASE_URL,
  collectOperations,
  isSecured,
  requestId,
  type OpenApiSpec,
} from './openapi-to-insomnia.js';

const ID_PATTERN = /^(wrk|fld|req|env)_[0-9a-f]{32}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FoundRequest {
  node: UnknownRecord;
  id: string;
  hasInheritedBearer: boolean;
}

interface WalkResult {
  metaIds: string[];
  requests: FoundRequest[];
  folderCount: number;
  failures: string[];
}

function metaId(node: UnknownRecord): string {
  const meta = node['meta'];
  return isRecord(meta) && typeof meta['id'] === 'string' ? meta['id'] : '';
}

function hasBearerAuth(node: UnknownRecord): boolean {
  const auth = node['authentication'];
  return isRecord(auth) && auth['type'] === 'bearer' && auth['token'] === ADMIN_TOKEN_TEMPLATE;
}

function entriesCarryNoIds(node: UnknownRecord, failures: string[], label: string): void {
  // Schema 5.1 removed `id` fields from header/parameter entries; emitting
  // them would round-trip badly through Insomnia's importer.
  for (const key of ['parameters', 'pathParameters', 'headers']) {
    const entries = node[key];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (isRecord(entry) && 'id' in entry) {
          failures.push(`${label}: '${key}' entry carries a forbidden 'id' field`);
        }
      }
    }
  }
}

// Folder vs request is structural in the v5 importer: a folder has `children`
// and no `method`/`url`; a request has `method` and no `children`.
function walkItems(items: unknown, inheritedBearer: boolean, result: WalkResult): void {
  if (!Array.isArray(items)) {
    result.failures.push('collection items are not an array');
    return;
  }
  for (const item of items) {
    if (!isRecord(item)) {
      result.failures.push('collection item is not an object');
      continue;
    }
    const id = metaId(item);
    result.metaIds.push(id);
    if ('children' in item) {
      result.folderCount += 1;
      for (const forbidden of ['method', 'url', 'parameters', 'pathParameters']) {
        if (forbidden in item) {
          result.failures.push(
            `folder '${String(item['name'])}' carries '${forbidden}' — the importer would misclassify it as a request`,
          );
        }
      }
      walkItems(item['children'], inheritedBearer || hasBearerAuth(item), result);
    } else if (typeof item['method'] === 'string') {
      entriesCarryNoIds(item, result.failures, `request '${String(item['name'])}'`);
      const url = item['url'];
      if (typeof url !== 'string' || !url.startsWith(BASE_URL_TEMPLATE)) {
        result.failures.push(
          `request '${String(item['name'])}' url does not start with ${BASE_URL_TEMPLATE}`,
        );
      }
      result.requests.push({
        node: item,
        id,
        hasInheritedBearer: inheritedBearer || hasBearerAuth(item),
      });
    } else {
      result.failures.push('collection item is neither a folder (children) nor a request (method)');
    }
  }
}

function validateEnvironments(doc: UnknownRecord, prodUrl: string, result: WalkResult): void {
  const envs = doc['environments'];
  if (!isRecord(envs)) {
    result.failures.push('environments block missing');
    return;
  }
  result.metaIds.push(metaId(envs));
  const data = envs['data'];
  if (!isRecord(data) || data['base_url'] !== LOCAL_BASE_URL || data['admin_token'] !== '') {
    result.failures.push('base environment must hold base_url=localhost and an EMPTY admin_token');
  }
  const subs = envs['subEnvironments'];
  if (!Array.isArray(subs) || subs.length !== 2) {
    result.failures.push('expected exactly 2 sub-environments (Local, Production)');
    return;
  }
  const [local, prod] = subs as [unknown, unknown];
  if (!isRecord(local) || local['name'] !== 'Local') {
    result.failures.push("first sub-environment must be 'Local'");
  } else {
    result.metaIds.push(metaId(local));
    const localData = local['data'];
    if (!isRecord(localData) || localData['base_url'] !== LOCAL_BASE_URL) {
      result.failures.push(`Local sub-environment base_url must be ${LOCAL_BASE_URL}`);
    }
  }
  if (!isRecord(prod) || prod['name'] !== 'Production') {
    result.failures.push("second sub-environment must be 'Production'");
  } else {
    result.metaIds.push(metaId(prod));
    const prodData = prod['data'];
    if (!isRecord(prodData) || prodData['base_url'] !== prodUrl) {
      result.failures.push(`Production sub-environment base_url must be ${prodUrl}`);
    }
  }
}

// Parse the emitted YAML back and assert every import-critical invariant.
// Returns failure descriptions (empty = valid).
export function validateDocument(yamlText: string, spec: OpenApiSpec, prodUrl: string): string[] {
  const doc: unknown = parse(yamlText);
  if (!isRecord(doc)) {
    return ['emitted YAML did not parse to an object'];
  }
  const result: WalkResult = { metaIds: [], requests: [], folderCount: 0, failures: [] };

  if (doc['type'] !== 'collection.insomnia.rest/5.0') {
    result.failures.push("top-level 'type' must be 'collection.insomnia.rest/5.0'");
  }
  if (doc['schema_version'] !== '5.1') {
    result.failures.push("'schema_version' must be '5.1'");
  }
  result.metaIds.push(metaId(doc));
  walkItems(doc['collection'], false, result);
  validateEnvironments(doc, prodUrl, result);

  for (const id of result.metaIds) {
    if (!ID_PATTERN.test(id)) {
      result.failures.push(`meta.id '${id}' does not match ${String(ID_PATTERN)}`);
    }
  }
  if (new Set(result.metaIds).size !== result.metaIds.length) {
    result.failures.push('meta.id values are not unique');
  }

  // Every spec operation appears exactly once — compared by recomputing the
  // deterministic ids, so this also pins request count to the spec.
  const ops = collectOperations(spec);
  const expectedIds = new Map(ops.map((op) => [requestId(op.method, op.path), op]));
  const foundIds = new Set(result.requests.map((r) => r.id));
  for (const [id, op] of expectedIds) {
    if (!foundIds.has(id)) {
      result.failures.push(`operation ${op.method} ${op.path} missing from output`);
    }
  }
  if (result.requests.length !== ops.length) {
    result.failures.push(`expected ${ops.length} requests, found ${result.requests.length}`);
  }

  for (const found of result.requests) {
    const op = expectedIds.get(found.id);
    if (op && isSecured(op.operation) && !found.hasInheritedBearer) {
      result.failures.push(
        `secured operation ${op.method} ${op.path} has no bearer auth on itself or an ancestor folder`,
      );
    }
  }

  // The destructive reset must ship disarmed: param present, value complete,
  // checkbox off — the server's ?confirm=wipe-all gate stays the second lock.
  const resetRequest = result.requests.find(
    (r) => r.id === requestId('POST', '/api/v1/admin/reset'),
  );
  if (resetRequest) {
    const params = resetRequest.node['parameters'];
    // Array.isArray narrows `unknown` to `any[]`; cast to `unknown[]` so `.find`
    // returns `unknown` (not `any`) and the result stays type-safe.
    const confirm = Array.isArray(params)
      ? (params as unknown[]).find((p) => isRecord(p) && p['name'] === 'confirm')
      : undefined;
    if (!isRecord(confirm) || confirm['value'] !== 'wipe-all' || confirm['disabled'] !== true) {
      result.failures.push(
        "POST /api/v1/admin/reset must ship 'confirm=wipe-all' present but disabled",
      );
    }
  }

  return result.failures;
}
