// Unit tests for the OpenAPI→Insomnia translation (issue #350). Run via
// `pnpm scripts:test` (node's built-in runner through tsx). This module is pure
// and already import-safe, so the helpers are exercised directly and the
// internal ones (path/query value resolution, auth, the disarmed reset) through
// openapiToInsomnia's output. scripts/ is outside the coverage gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_TOKEN_TEMPLATE,
  BASE_URL_TEMPLATE,
  LOCAL_BASE_URL,
  collectOperations,
  isSecured,
  openapiToInsomnia,
  requestId,
  stableId,
  type InsomniaItem,
  type InsomniaRequest,
  type OpenApiSpec,
} from './openapi-to-insomnia.js';

const PROD = 'https://api.example.test';

// A spec wide enough to exercise path params, the query-value priority chain,
// the enabled/disabled rule, the disarmed reset, folder auth, and determinism.
function spec(): OpenApiSpec {
  return {
    info: { title: 'liner-notes API', description: 'graph of a record collection' },
    tags: [{ name: 'releases' }, { name: 'explore' }, { name: 'search' }, { name: 'admin' }],
    paths: {
      '/api/v1/releases/{discogsId}': {
        get: { tags: ['releases'], parameters: [{ name: 'discogsId', in: 'path' }] },
      },
      '/api/v1/explore/musician/{name}': {
        get: { tags: ['explore'], parameters: [{ name: 'name', in: 'path' }] },
      },
      '/api/v1/foo/{bar}': {
        get: { tags: ['explore'], parameters: [{ name: 'bar', in: 'path' }] },
      },
      '/api/v1/q': {
        get: {
          tags: ['explore'],
          parameters: [
            { name: 'withDefault', in: 'query', schema: { default: 'D' } },
            { name: 'withExample', in: 'query', example: 'E' },
            { name: 'withEnum', in: 'query', schema: { enum: ['first', 'second'] } },
            {
              name: 'withRange',
              in: 'query',
              schema: { type: 'integer', minimum: 0, maximum: 10 },
            },
            { name: 'bare', in: 'query' },
          ],
        },
      },
      '/api/v1/search': {
        get: {
          tags: ['search'],
          parameters: [
            { name: 'q', in: 'query' },
            { name: 'mode', in: 'query', required: true },
          ],
        },
      },
      '/api/v1/admin/reset': {
        post: {
          tags: ['admin'],
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'confirm', in: 'query' }],
        },
      },
    },
  };
}

function findRequestById(items: InsomniaItem[], id: string): InsomniaRequest | undefined {
  for (const item of items) {
    if ('children' in item) {
      const found = findRequestById(item.children, id);
      if (found) return found;
    } else if (item.meta.id === id) {
      return item;
    }
  }
  return undefined;
}

test('stableId: deterministic, prefixed, and seed-sensitive', () => {
  assert.equal(stableId('wrk', 'seed'), stableId('wrk', 'seed'));
  assert.match(stableId('fld', 'x'), /^fld_[0-9a-f]{32}$/);
  assert.notEqual(stableId('req', 'a'), stableId('req', 'b'));
});

test('requestId: stable id derived from method + path', () => {
  assert.equal(requestId('GET', '/x'), requestId('GET', '/x'));
  assert.match(requestId('POST', '/y'), /^req_[0-9a-f]{32}$/);
  assert.notEqual(requestId('GET', '/x'), requestId('POST', '/x'));
});

test('collectOperations: ops in path-insertion then fixed HTTP-method order', () => {
  const s: OpenApiSpec = { paths: { '/a': { get: {}, post: {} }, '/b': { get: {} } } };
  assert.deepEqual(
    collectOperations(s).map((o) => `${o.method} ${o.path}`),
    ['GET /a', 'POST /a', 'GET /b'],
  );
});

test('isSecured: true only when a security entry names bearerAuth', () => {
  assert.equal(isSecured({ security: [{ bearerAuth: [] }] }), true);
  assert.equal(isSecured({ security: [{ other: [] }] }), false);
  assert.equal(isSecured({}), false);
});

test('openapiToInsomnia: path params resolve (map hit, explore segment, fallback) + url template', () => {
  const doc = openapiToInsomnia(spec(), { prodUrl: PROD });
  const releases = findRequestById(
    doc.collection,
    requestId('GET', '/api/v1/releases/{discogsId}'),
  );
  const musician = findRequestById(
    doc.collection,
    requestId('GET', '/api/v1/explore/musician/{name}'),
  );
  const foo = findRequestById(doc.collection, requestId('GET', '/api/v1/foo/{bar}'));
  assert.ok(releases && musician && foo);
  assert.deepEqual(releases.pathParameters, [{ name: 'discogsId', value: '249504' }]);
  assert.deepEqual(musician.pathParameters, [{ name: 'name', value: 'Steve Gadd' }]);
  assert.deepEqual(foo.pathParameters, [{ name: 'bar', value: 'example' }]);
  assert.equal(releases.url, `${BASE_URL_TEMPLATE}/api/v1/releases/:discogsId`);
});

test('openapiToInsomnia: query value priority chain, disabled by default', () => {
  const doc = openapiToInsomnia(spec(), { prodUrl: PROD });
  const req = findRequestById(doc.collection, requestId('GET', '/api/v1/q'));
  assert.ok(req);
  assert.deepEqual(req.parameters, [
    { name: 'withDefault', value: 'D', disabled: true },
    { name: 'withExample', value: 'E', disabled: true },
    { name: 'withEnum', value: 'first', disabled: true },
    { name: 'withRange', value: '5', disabled: true }, // integer midpoint of [0,10]
    { name: 'bare', value: 'example', disabled: true },
  ]);
});

test('openapiToInsomnia: curated search q and required params ship enabled', () => {
  const doc = openapiToInsomnia(spec(), { prodUrl: PROD });
  const search = findRequestById(doc.collection, requestId('GET', '/api/v1/search'));
  assert.ok(search);
  // q is in ENABLED_QUERY_PARAMS with override 'blue'; mode is required → both enabled.
  assert.deepEqual(search.parameters, [
    { name: 'q', value: 'blue' },
    { name: 'mode', value: 'example' },
  ]);
});

test('openapiToInsomnia: the destructive reset ships confirm=wipe-all but disabled', () => {
  const doc = openapiToInsomnia(spec(), { prodUrl: PROD });
  const reset = findRequestById(doc.collection, requestId('POST', '/api/v1/admin/reset'));
  assert.ok(reset);
  assert.deepEqual(reset.parameters, [{ name: 'confirm', value: 'wipe-all', disabled: true }]);
});

test('openapiToInsomnia: the admin folder carries the bearer token template', () => {
  const doc = openapiToInsomnia(spec(), { prodUrl: PROD });
  const admin = doc.collection.find((i) => i.name === 'admin');
  assert.ok(admin && 'children' in admin);
  assert.deepEqual(admin.authentication, { type: 'bearer', token: ADMIN_TOKEN_TEMPLATE });
});

test('openapiToInsomnia: base + sub environments hold the expected urls', () => {
  const doc = openapiToInsomnia(spec(), { prodUrl: PROD });
  assert.equal(doc.environments.data['base_url'], LOCAL_BASE_URL);
  assert.equal(doc.environments.data['admin_token'], '');
  const [local, prod] = doc.environments.subEnvironments;
  assert.ok(local && prod);
  assert.equal(local.data['base_url'], LOCAL_BASE_URL);
  assert.equal(prod.data['base_url'], PROD);
});

test('openapiToInsomnia: output is deterministic across runs', () => {
  assert.deepEqual(
    openapiToInsomnia(spec(), { prodUrl: PROD }),
    openapiToInsomnia(spec(), { prodUrl: PROD }),
  );
});
