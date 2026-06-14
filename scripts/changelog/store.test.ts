// Unit tests for the pure, gh-independent bits of store.ts. The gh I/O itself is
// integration-only, but the FAILURE CLASSIFICATION — "release genuinely absent" vs
// "transient error" — is the load-bearing distinction (a misclassification silently
// wipes the store on the next write), so it's extracted as a pure function and tested
// here. Run with `pnpm changelog:test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReleaseNotFound } from './store.js';

test('isReleaseNotFound: true ONLY for a genuine "release not found" / 404', () => {
  // gh prints exactly this (exit 1) when the release/draft does not exist:
  assert.equal(isReleaseNotFound('release not found'), true);
  assert.equal(isReleaseNotFound('Release Not Found\n'), true); // case-insensitive
  assert.equal(isReleaseNotFound('gh: HTTP 404: Not Found'), true);
});

test('isReleaseNotFound: false for transient/other failures (must NOT read as absence)', () => {
  // These must classify as errors so the reader THROWS instead of degrading to empty —
  // otherwise a blip wipes the store on write-back (the bug this guards).
  assert.equal(isReleaseNotFound('dial tcp: connection refused'), false);
  assert.equal(isReleaseNotFound('API rate limit exceeded'), false);
  assert.equal(isReleaseNotFound('HTTP 503: Service Unavailable'), false);
  assert.equal(isReleaseNotFound('gh auth: authentication required'), false);
  assert.equal(isReleaseNotFound(''), false); // no stderr → don't assume absence
});
