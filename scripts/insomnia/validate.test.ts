// Unit tests for the Insomnia self-validation guard (issue #350). Run via
// `pnpm scripts:test`. Builds a collection via openapiToInsomnia, serializes it
// exactly as generate.ts does, then asserts validateDocument both passes clean
// and catches tampering — notably a re-armed reset. Tampering is on the YAML
// TEXT, not the spec: validateDocument re-derives expected ids from the spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { openapiToInsomnia, requestId, type OpenApiSpec } from './openapi-to-insomnia.js';
import { validateDocument } from './validate.js';

const PROD = 'https://api.example.test';

// Minimal spec hitting every conditional branch: a non-secured GET, plus a
// secured admin POST /reset with an OPTIONAL confirm query param (so it resolves
// to value 'wipe-all', disabled: true — the disarmed state validateDocument
// requires).
function spec(): OpenApiSpec {
  return {
    info: { title: 'liner-notes API', description: 'd' },
    tags: [{ name: 'health' }, { name: 'admin' }],
    paths: {
      '/api/v1/health': { get: { tags: ['health'] } },
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

function build(): string {
  return stringify(openapiToInsomnia(spec(), { prodUrl: PROD }), {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  });
}

test('validateDocument: a freshly generated document validates clean', () => {
  assert.deepEqual(validateDocument(build(), spec(), PROD), []);
});

test('validateDocument: catches a re-armed reset (confirm no longer disabled)', () => {
  // The confirm param is the only disabled:true in this minimal collection.
  const clean = build();
  const tampered = clean.replace('disabled: true', 'disabled: false');
  // Guard against a silent no-op replace (which would make this a false green).
  assert.notEqual(tampered, clean, 'tamper missed: no `disabled: true` to flip');
  const failures = validateDocument(tampered, spec(), PROD);
  assert.ok(
    failures.some((f) => f.includes("POST /api/v1/admin/reset must ship 'confirm=wipe-all'")),
    `expected a reset-disarm failure, got: ${JSON.stringify(failures)}`,
  );
});

test('validateDocument: catches duplicate meta.id values', () => {
  // Collide two request ids by giving the health request the reset request's id.
  const clean = build();
  const tampered = clean.replace(
    requestId('GET', '/api/v1/health'),
    requestId('POST', '/api/v1/admin/reset'),
  );
  // Guard against a silent no-op replace (which would make this a false green).
  assert.notEqual(tampered, clean, 'tamper missed: health request id not found');
  const failures = validateDocument(tampered, spec(), PROD);
  assert.ok(
    failures.some((f) => f.includes('meta.id values are not unique')),
    `expected a uniqueness failure, got: ${JSON.stringify(failures)}`,
  );
});
