// Tests for the load-bearing safety classifier: isUnreachable decides whether a
// connectivity failure is "DB asleep → clean no-op (exit 0)" vs a real error that
// must propagate and fail loud. A misclassification means either a churning red
// workflow or a silently-skipped genuine failure (e.g. rotated prod credentials),
// so the boundary cases are pinned here. (Importing introspect.ts pulls in
// neo4j-driver, but the test never opens a connection.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnreachable } from './introspect.js';

test('asleep/unreachable: connection-level codes classify as unreachable', () => {
  for (const code of [
    'ServiceUnavailable',
    'SessionExpired',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ECONNRESET',
  ]) {
    assert.equal(isUnreachable({ code }), true, `${code} should be unreachable`);
  }
});

test('asleep/unreachable: a nested cause.code is honored', () => {
  assert.equal(isUnreachable({ message: 'wrap', cause: { code: 'ECONNREFUSED' } }), true);
});

test('asleep/unreachable: message fallback matches connection-ish text', () => {
  assert.equal(isUnreachable({ message: 'Failed to establish connection to host' }), true);
  assert.equal(
    isUnreachable({ message: 'Could not perform discovery. No routing servers.' }),
    true,
  );
});

test('NOT unreachable: an auth failure must propagate (the dangerous case)', () => {
  // A rotated/wrong prod credential must fail loud, never be masked as "asleep".
  assert.equal(
    isUnreachable({
      code: 'Neo.ClientError.Security.Unauthorized',
      message: 'The client is unauthorized due to authentication failure.',
    }),
    false,
  );
});

test('NOT unreachable: a real query/syntax error propagates', () => {
  assert.equal(
    isUnreachable({ code: 'Neo.ClientError.Statement.SyntaxError', message: 'Invalid input' }),
    false,
  );
});

test('NOT unreachable: empty/odd shapes do not classify as asleep', () => {
  assert.equal(isUnreachable({}), false);
  assert.equal(isUnreachable(null), false);
  assert.equal(isUnreachable(new Error('something unrelated')), false);
});
