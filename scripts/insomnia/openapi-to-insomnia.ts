// Pure transform: OpenAPI 3.0.3 spec → Insomnia v5 collection document
// (`type: collection.insomnia.rest/5.0`, schema_version 5.1).
//
// No I/O here — generate.ts owns reading, YAML emission, self-validation and
// writing. Determinism is the core constraint (the committed YAML is
// drift-checked in CI): ids are sha256 hashes of stable seeds, there are no
// timestamps, and iteration follows the spec's own insertion order everywhere.
//
// Field names were verified against Insomnia's import schema
// (packages/insomnia/src/common/import-v5-parser.ts). Two non-obvious rules
// from that schema:
//   - folders are distinguished from requests structurally: a folder carries
//     `children` and must NOT have `method`/`url`; a request has `method` and
//     must NOT have a `children` key.
//   - `pathParameters` entries have no `disabled` flag, so they always ship
//     with example values. Query `parameters` do support `disabled`.

import { createHash } from 'node:crypto';

// --- OpenAPI input (the subset this spec actually uses) ---------------------

interface OpenApiSchema {
  type?: string;
  default?: unknown;
  example?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  example?: unknown;
  schema?: OpenApiSchema;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  parameters?: OpenApiParameter[];
  security?: Record<string, unknown>[];
}

export interface OpenApiSpec {
  info?: { title?: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface Operation {
  method: string; // upper-case
  path: string; // OpenAPI form, e.g. /api/v1/releases/{discogsId}
  operation: OpenApiOperation;
}

// --- Insomnia v5 output subset ----------------------------------------------

export interface InsomniaMeta {
  id: string;
  description?: string;
  sortKey?: number;
}

export interface InsomniaQueryParameter {
  name: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

export interface InsomniaPathParameter {
  name: string;
  value: string;
}

export interface InsomniaBearerAuth {
  type: 'bearer';
  token: string;
}

export interface InsomniaRequest {
  name: string;
  meta: InsomniaMeta;
  url: string;
  method: string;
  parameters?: InsomniaQueryParameter[];
  pathParameters?: InsomniaPathParameter[];
  authentication?: InsomniaBearerAuth;
}

export interface InsomniaFolder {
  name: string;
  meta: InsomniaMeta;
  authentication?: InsomniaBearerAuth;
  children: InsomniaItem[];
}

export type InsomniaItem = InsomniaFolder | InsomniaRequest;

export interface InsomniaEnvironment {
  name: string;
  meta: InsomniaMeta;
  data: Record<string, string>;
}

export interface InsomniaBaseEnvironment extends InsomniaEnvironment {
  subEnvironments: InsomniaEnvironment[];
}

export interface InsomniaCollectionFile {
  type: 'collection.insomnia.rest/5.0';
  schema_version: '5.1';
  name: string;
  meta: InsomniaMeta;
  collection: InsomniaItem[];
  environments: InsomniaBaseEnvironment;
}

// --- Constants ---------------------------------------------------------------

export const LOCAL_BASE_URL = 'http://localhost:3000';
// Already public in README/CLAUDE.md; forks override via PROD_API_URL.
export const DEFAULT_PROD_URL = 'https://ln-api.impressivelyadequate.com';
export const BASE_URL_TEMPLATE = '{{ _.base_url }}';
export const ADMIN_TOKEN_TEMPLATE = '{{ _.admin_token }}';

const ADMIN_PATH_PREFIX = '/api/v1/admin/';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const SORT_KEY_STEP = 100;

// Example values for path params. The spec defines 4 distinct params; the
// fourth, {name}, is resolved per explore segment via EXPLORE_NAME_SAMPLES
// below instead of one fixed value here. Illustrative only — a 404 on "send"
// is fine; they exist so requests are runnable without edits.
const PATH_PARAM_VALUES = new Map<string, string>([
  ['discogsId', '249504'],
  ['year', '1977'],
  ['decade', '1970'],
]);

// /api/v1/explore/<segment>/{name} — a per-segment sample beats one generic
// name because each explore route matches a different node label.
const EXPLORE_NAME_SAMPLES = new Map<string, string>([
  ['musician', 'Steve Gadd'],
  ['producer', 'Quincy Jones'],
  ['engineer', 'Bob Clearmountain'],
  ['studio', 'Abbey Road Studios'],
  ['label', 'Blue Note'],
  ['genre', 'Jazz'],
  ['style', 'Hard Bop'],
  ['country', 'US'],
]);

// Query params that ship ENABLED despite being spec-optional: the search
// routes 400 without `q`, so an out-of-the-box send must include it.
const ENABLED_QUERY_PARAMS = new Set(['GET /api/v1/search?q', 'GET /api/v1/search/lyrics?q']);

// Curated values where the spec has no default/example/enum to derive from.
// `confirm=wipe-all` is intentionally complete-but-disabled: enabling the
// checkbox is the one deliberate act needed to arm the destructive reset.
const QUERY_PARAM_VALUE_OVERRIDES = new Map<string, string>([
  ['GET /api/v1/search?q', 'blue'],
  ['GET /api/v1/search/lyrics?q', 'love'],
  ['POST /api/v1/admin/reset?confirm', 'wipe-all'],
  ['GET /api/v1/explore/tracks/by-audio-features?minTempo', '90'],
  ['GET /api/v1/explore/tracks/by-audio-features?maxTempo', '140'],
  ['GET /api/v1/explore/tracks/by-audio-features?key', 'C'],
]);

// --- Helpers ------------------------------------------------------------------

// Insomnia-convention ids (<prefix>_<hex>) derived from stable seeds, so the
// same spec always produces the same bytes. generate.ts recomputes these to
// verify every operation landed in the output exactly once.
export function stableId(prefix: 'wrk' | 'fld' | 'req' | 'env', seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

export function requestId(method: string, path: string): string {
  return stableId('req', `req:${method} ${path}`);
}

// Spec paths-object insertion order, methods in fixed HTTP order per path.
export function collectOperations(spec: OpenApiSpec): Operation[] {
  const ops: Operation[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation) {
        ops.push({ method: method.toUpperCase(), path, operation });
      }
    }
  }
  return ops;
}

export function isSecured(operation: OpenApiOperation): boolean {
  return (operation.security ?? []).some((entry) => 'bearerAuth' in entry);
}

function pathParamValue(name: string, path: string): string {
  if (name === 'name') {
    // '/api/v1/explore/musician/{name}'.split('/')[4] === 'musician'
    const segment = path.split('/')[4] ?? '';
    return EXPLORE_NAME_SAMPLES.get(segment) ?? 'example';
  }
  return PATH_PARAM_VALUES.get(name) ?? 'example';
}

function queryParamValue(opKey: string, param: OpenApiParameter): string {
  const override = QUERY_PARAM_VALUE_OVERRIDES.get(`${opKey}?${param.name}`);
  if (override !== undefined) {
    return override;
  }
  const schema = param.schema ?? {};
  if (schema.default !== undefined) {
    return String(schema.default);
  }
  const example = param.example ?? schema.example;
  if (example !== undefined) {
    return String(example);
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return String(schema.enum[0]);
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && schema.maximum !== undefined) {
      const mid = (schema.minimum + schema.maximum) / 2;
      return String(schema.type === 'integer' ? Math.round(mid) : mid);
    }
    return String(schema.minimum ?? 1);
  }
  return 'example';
}

function buildRequest(op: Operation, sortIndex: number, needsOwnAuth: boolean): InsomniaRequest {
  const opKey = `${op.method} ${op.path}`;
  const request: InsomniaRequest = {
    name: op.operation.summary ?? opKey,
    meta: { id: requestId(op.method, op.path), sortKey: sortIndex * SORT_KEY_STEP },
    url: BASE_URL_TEMPLATE + op.path.replace(/\{(\w+)\}/g, ':$1'),
    method: op.method,
  };

  const queryParams: InsomniaQueryParameter[] = [];
  const pathParams: InsomniaPathParameter[] = [];
  for (const param of op.operation.parameters ?? []) {
    if (param.in === 'query') {
      const enabled = param.required === true || ENABLED_QUERY_PARAMS.has(`${opKey}?${param.name}`);
      const entry: InsomniaQueryParameter = {
        name: param.name,
        value: queryParamValue(opKey, param),
      };
      if (param.description) {
        entry.description = param.description;
      }
      if (!enabled) {
        entry.disabled = true;
      }
      queryParams.push(entry);
    } else if (param.in === 'path') {
      pathParams.push({ name: param.name, value: pathParamValue(param.name, op.path) });
    }
  }
  if (queryParams.length > 0) {
    request.parameters = queryParams;
  }
  if (pathParams.length > 0) {
    request.pathParameters = pathParams;
  }
  if (needsOwnAuth) {
    request.authentication = { type: 'bearer', token: ADMIN_TOKEN_TEMPLATE };
  }
  return request;
}

// The admin folder nests one sub-folder per stage segment (the path piece
// after /api/v1/admin/), in first-appearance order. An admin-tagged route
// outside that prefix (none today) would land directly in the folder.
function buildAdminChildren(ops: Operation[]): InsomniaItem[] {
  const items: InsomniaItem[] = [];
  const subFolders = new Map<string, InsomniaFolder>();
  for (const op of ops) {
    if (!op.path.startsWith(ADMIN_PATH_PREFIX)) {
      items.push(buildRequest(op, items.length, false));
      continue;
    }
    const segment = op.path.slice(ADMIN_PATH_PREFIX.length).split('/')[0] ?? '';
    let folder = subFolders.get(segment);
    if (!folder) {
      folder = {
        name: segment,
        meta: {
          id: stableId('fld', `fld:admin:${segment}`),
          sortKey: items.length * SORT_KEY_STEP,
        },
        children: [],
      };
      subFolders.set(segment, folder);
      items.push(folder);
    }
    folder.children.push(buildRequest(op, folder.children.length, false));
  }
  return items;
}

function buildTagFolder(
  tag: string,
  tagDescription: string | undefined,
  ops: Operation[],
  sortIndex: number,
): InsomniaFolder {
  const meta: InsomniaMeta = { id: stableId('fld', `fld:tag:${tag}`) };
  if (tagDescription) {
    meta.description = tagDescription;
  }
  meta.sortKey = sortIndex * SORT_KEY_STEP;

  // Key insertion order is YAML emission order — authentication goes in
  // before the (long) children array so it's visible at the top of the folder.
  if (tag === 'admin') {
    return {
      name: tag,
      meta,
      // One bearer definition; every admin request inherits it (leaf→root
      // resolution verified in Insomnia's getOrInheritAuthentication).
      authentication: { type: 'bearer', token: ADMIN_TOKEN_TEMPLATE },
      children: buildAdminChildren(ops),
    };
  }
  return {
    name: tag,
    meta,
    children: ops.map((op, i) => buildRequest(op, i, isSecured(op.operation))),
  };
}

// --- Entry point ----------------------------------------------------------------

export function openapiToInsomnia(
  spec: OpenApiSpec,
  opts: { prodUrl: string },
): InsomniaCollectionFile {
  const ops = collectOperations(spec);

  const byTag = new Map<string, Operation[]>();
  for (const op of ops) {
    // 'untagged' is a defensive fallback — every op carries a tag today, and
    // generate.ts asserts every op lands in the output exactly once.
    const tag = op.operation.tags?.[0] ?? 'untagged';
    const group = byTag.get(tag);
    if (group) {
      group.push(op);
    } else {
      byTag.set(tag, [op]);
    }
  }

  const specTagOrder = (spec.tags ?? []).map((t) => t.name);
  const orderedTags = [
    ...specTagOrder.filter((tag) => byTag.has(tag)),
    ...[...byTag.keys()].filter((tag) => !specTagOrder.includes(tag)),
  ];
  const tagDescriptions = new Map((spec.tags ?? []).map((t) => [t.name, t.description]));

  const workspaceMeta: InsomniaMeta = { id: stableId('wrk', 'wrk:liner-notes') };
  if (spec.info?.description) {
    workspaceMeta.description = spec.info.description;
  }

  return {
    type: 'collection.insomnia.rest/5.0',
    schema_version: '5.1',
    name: spec.info?.title ?? 'liner-notes API',
    meta: workspaceMeta,
    collection: orderedTags.map((tag, i) =>
      buildTagFolder(tag, tagDescriptions.get(tag), byTag.get(tag) ?? [], i),
    ),
    environments: {
      name: 'Base Environment',
      meta: { id: stableId('env', 'env:base') },
      // admin_token is deliberately committed empty — paste the real token in
      // Insomnia after import. Never commit a real value.
      data: { base_url: LOCAL_BASE_URL, admin_token: '' },
      subEnvironments: [
        {
          name: 'Local',
          meta: { id: stableId('env', 'env:sub:Local') },
          data: { base_url: LOCAL_BASE_URL },
        },
        {
          name: 'Production',
          meta: { id: stableId('env', 'env:sub:Production') },
          data: { base_url: opts.prodUrl },
        },
      ],
    },
  };
}
