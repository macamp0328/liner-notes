// Unit tests for the pure, gh-independent bits of store.ts. The gh I/O itself is
// integration-only, but the FAILURE CLASSIFICATION — "release genuinely absent" vs
// "transient error" — is the load-bearing distinction (a misclassification silently
// wipes the store on the next write), so it's extracted as a pure function and tested
// here. Likewise the transient-retry decision logic (`retryTransient`), which takes
// injectable sleep/warn so it's testable without invoking gh. Run with
// `pnpm changelog:test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRefAlreadyExists, isReleaseNotFound, retryTransient } from './store.js';

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

test('isRefAlreadyExists: true ONLY for a genuine tag-ref collision', () => {
  // The Git Data API's 422 when the tag ref already exists, as gh renders it:
  assert.equal(isRefAlreadyExists('HTTP 422: Reference already exists'), true);
  assert.equal(isRefAlreadyExists('gh: Reference already exists (HTTP 422)'), true);
});

test('isRefAlreadyExists: false for transient/other failures (must NOT read as a collision)', () => {
  // A misclassification here would turn a network blip into a bogus `.N` suffix
  // recompute (and a second doomed create) instead of a loud, retryable failure.
  assert.equal(isRefAlreadyExists('read tcp: read: connection reset by peer'), false);
  assert.equal(isRefAlreadyExists('HTTP 403: Resource not accessible by integration'), false);
  assert.equal(isRefAlreadyExists('HTTP 503: Service Unavailable'), false);
  assert.equal(isRefAlreadyExists(''), false);
});

// ── retryTransient ────────────────────────────────────────────────────────────

/** Error shaped like a thrown execFileSync failure (stderr carries gh's message). */
function ghError(stderr: string): Error {
  return Object.assign(new Error(`gh failed: ${stderr}`), { stderr });
}

const silent = { sleep: () => {}, warn: () => {} };

test('retryTransient: first success returns immediately — no sleeps, no warnings', () => {
  const delays: number[] = [];
  const result = retryTransient(() => 'ok', {
    label: 'gh release download',
    sleep: (ms) => delays.push(ms),
    warn: () => {},
  });
  assert.equal(result, 'ok');
  assert.deepEqual(delays, []);
});

test('retryTransient: transient blip clears on a later attempt (the #503 failure mode)', () => {
  // The exact failure that red the changelog job: the release-asset CDN resetting
  // the connection mid-download. One blip must not fail the job.
  const delays: number[] = [];
  let calls = 0;
  const result = retryTransient(
    () => {
      calls++;
      if (calls < 3) throw ghError('read tcp: read: connection reset by peer');
      return 'store contents';
    },
    { label: 'gh release download', sleep: (ms) => delays.push(ms), warn: () => {} },
  );
  assert.equal(result, 'store contents');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 4000]); // exponential backoff
});

test('retryTransient: persistent failure exhausts attempts and rethrows the ORIGINAL error', () => {
  // The original error object (not a wrapper) must propagate so callers can still
  // classify it by stderr (viewReleaseJson's absent-vs-transient distinction).
  const boom = ghError('HTTP 503: Service Unavailable');
  let calls = 0;
  assert.throws(
    () =>
      retryTransient(
        () => {
          calls++;
          throw boom;
        },
        { label: 'gh release view', ...silent },
      ),
    (err: unknown) => err === boom,
  );
  assert.equal(calls, 3); // default attempts
});

test('retryTransient: expected failures short-circuit — no retries, no sleeps', () => {
  // "release not found" is a legitimate ANSWER (first-run empty store), not a blip —
  // retrying it 3× would just add ~6s of delay to every legit empty read.
  const notFound = ghError('release not found');
  const delays: number[] = [];
  let calls = 0;
  assert.throws(
    () =>
      retryTransient(
        () => {
          calls++;
          throw notFound;
        },
        {
          label: 'gh release view',
          isExpectedFailure: isReleaseNotFound,
          sleep: (ms) => delays.push(ms),
          warn: () => {},
        },
      ),
    (err: unknown) => err === notFound,
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('retryTransient: honours a custom attempts count', () => {
  let calls = 0;
  assert.throws(() =>
    retryTransient(
      () => {
        calls++;
        throw ghError('dial tcp: connection refused');
      },
      { label: 'gh api', attempts: 5, ...silent },
    ),
  );
  assert.equal(calls, 5);
});
