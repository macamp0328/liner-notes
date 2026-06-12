import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
  type MockInstance,
} from 'vitest';
import {
  createRateLimitedFetch,
  RetriesExhaustedError,
  type RateLimitedFetchConfig,
} from '../../../src/ingestion/rate-limited-fetch.js';
import { CircuitBreaker, CircuitBreakerOpenError } from '../../../src/ingestion/circuit-breaker.js';

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  statusText = '',
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name: string) => headers[name] ?? null },
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

/**
 * Build a transient network-level error like the ones undici throws. `code`, when given, is
 * attached as the error's `.cause.code` (the undici shape).
 */
function makeNetworkError(message: string, code?: string): Error {
  const err = new TypeError(message);
  if (code !== undefined) {
    (err as Error & { cause?: unknown }).cause = Object.assign(new Error(message), { code });
  }
  return err;
}

describe('createRateLimitedFetch', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let sleeps: number[];
  let warn: Mock<(msg: string) => void>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    sleeps = [];
    warn = vi.fn();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function build(
    overrides: Partial<RateLimitedFetchConfig> = {},
  ): ReturnType<typeof createRateLimitedFetch> {
    return createRateLimitedFetch({
      label: 'test-client',
      apiName: 'Test API',
      delayMs: 0,
      maxRetries: 3,
      backoffBaseMs: 0,
      retryStatuses: [429],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      // A never-aborting signal: keeps real AbortSignal.timeout timers out of the event loop while
      // still exercising the signal-attachment path. A distinct instance per call so the
      // fresh-per-attempt assertion below has something to compare.
      timeoutSignal: () => new AbortController().signal,
      logger: { info: vi.fn(), warn, error: vi.fn() },
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Success path
  // ---------------------------------------------------------------------------
  describe('success path', () => {
    it('returns the response unconsumed after a single fetch', async () => {
      const res = makeResponse(200);
      fetchSpy.mockResolvedValueOnce(res);

      const result = await build()('https://api.example.com/thing');

      expect(result).toBe(res);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('passes the init (headers) through to fetch, with a timeout signal attached', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200));
      const init = { headers: { 'User-Agent': 'liner-notes/test', Accept: 'application/json' } };

      await build()('https://api.example.com/thing', init);

      // init is spread into a fresh object so the per-attempt signal can be added — the headers
      // still forward verbatim, plus the signal (#357).
      const passed = fetchSpy.mock.calls[0]?.[1];
      expect(passed).toMatchObject(init);
      expect(passed?.signal).toBeInstanceOf(AbortSignal);
    });

    it('sleeps exactly delayMs after an ok response (trailing request spacing)', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200));

      await build({ delayMs: 1100 })('https://api.example.com/thing');

      expect(sleeps).toEqual([1100]);
    });

    it('does not apply the trailing delay to a non-ok non-retryable response', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(404));

      const result = await build({ delayMs: 1100 })('https://api.example.com/thing');

      expect(result.status).toBe(404);
      expect(sleeps).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Retry statuses
  // ---------------------------------------------------------------------------
  describe('retry statuses', () => {
    it('retries a 429 and succeeds on the next attempt', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(429)).mockResolvedValueOnce(makeResponse(200));

      const result = await build()('https://api.example.com/thing');

      expect(result.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('retries a 503 when it is in retryStatuses', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(503)).mockResolvedValueOnce(makeResponse(200));

      const result = await build({ retryStatuses: [429, 503] })('https://api.example.com/thing');

      expect(result.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns a 503 as-is when it is not in retryStatuses', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(503));

      const result = await build({ retryStatuses: [429] })('https://api.example.com/thing');

      expect(result.status).toBe(503);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(sleeps).toEqual([]);
    });

    it('returns 404 and 500 as-is with a single fetch and no sleep', async () => {
      for (const status of [404, 500]) {
        fetchSpy.mockResolvedValueOnce(makeResponse(status));
        const result = await build()('https://api.example.com/thing');
        expect(result.status).toBe(status);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(sleeps).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Retry-After handling
  // ---------------------------------------------------------------------------
  describe('Retry-After handling', () => {
    it('floors the wait at the server-specified Retry-After', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(makeResponse(200));

      // backoffBaseMs 0 + random()=0 would jitter to 0 without the Retry-After floor.
      await build({ random: () => 0 })('https://api.example.com/thing');

      expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    });

    it('falls back to the backoff schedule when Retry-After is not an integer', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': 'soon' }))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 100, random: () => 1 })('https://api.example.com/thing');

      expect(sleeps[0]).toBe(100);
    });

    it('advances the backoff schedule from the Retry-After wait, not the base schedule', async () => {
      // Two consecutive 429s with Retry-After 10s and base 100ms: the second wait must
      // double from the 10 000ms server wait (→ 20 000), not from the 100ms schedule.
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': '10' }))
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 100, random: () => 1 })('https://api.example.com/thing');

      // Final 0 is the trailing delayMs spacing after the eventual ok response.
      expect(sleeps).toEqual([10_000, 20_000, 0]);
    });
  });

  // ---------------------------------------------------------------------------
  // Backoff schedule + jitter
  // ---------------------------------------------------------------------------
  describe('backoff schedule', () => {
    it('doubles the wait on each retry (random()=1 pins jitter to the ceiling)', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 100, random: () => 1 })('https://api.example.com/thing');

      // Final 0 is the trailing delayMs spacing after the eventual ok response.
      expect(sleeps).toEqual([100, 200, 400, 0]);
    });

    it('caps the schedule at the default 32s ceiling', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 20_000, random: () => 1 })('https://api.example.com/thing');

      expect(sleeps).toEqual([20_000, 32_000, 0]);
    });

    it('respects a custom backoffCeilMs', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 4_000, backoffCeilMs: 5_000, random: () => 1 })(
        'https://api.example.com/thing',
      );

      expect(sleeps).toEqual([4_000, 5_000, 0]);
    });

    it('applies equal jitter: random()=0 sleeps half the base (#245)', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(429)).mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 1_000, random: () => 0 })('https://api.example.com/thing');

      expect(sleeps).toEqual([500, 0]);
    });
  });

  // ---------------------------------------------------------------------------
  // Exhaustion
  // ---------------------------------------------------------------------------
  describe('exhaustion', () => {
    it('throws RetriesExhaustedError after maxRetries + 1 attempts on persistent 429', async () => {
      fetchSpy.mockResolvedValue(makeResponse(429));

      const rlFetch = build({ maxRetries: 3 });
      await expect(rlFetch('https://api.example.com/thing')).rejects.toThrow(
        'Test API: exceeded max retries (3) for https://api.example.com/thing',
      );
      await expect(
        build({ maxRetries: 3 })('https://api.example.com/thing'),
      ).rejects.toBeInstanceOf(RetriesExhaustedError);

      expect(fetchSpy).toHaveBeenCalledTimes(8); // two runs of 4 attempts each
    });

    it('does not sleep or warn for the unreachable wait after the final attempt', async () => {
      fetchSpy.mockResolvedValue(makeResponse(429));

      await expect(build({ maxRetries: 3 })('https://api.example.com/thing')).rejects.toThrow(
        /exceeded max retries/,
      );

      // 4 fetches, but only 3 backoff waits/warns — none for the unreachable 4th.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(sleeps).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(3);
      for (const call of warn.mock.calls) {
        expect(call[0]).not.toContain('attempt 4/4');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Transient network errors
  // ---------------------------------------------------------------------------
  describe('transient network errors', () => {
    it('retries a transient network error and succeeds', async () => {
      fetchSpy
        .mockRejectedValueOnce(makeNetworkError('connection reset by peer', 'ECONNRESET'))
        .mockResolvedValueOnce(makeResponse(200));

      const result = await build()('https://api.example.com/thing');

      expect(result.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
    });

    it('rethrows the original error (not RetriesExhaustedError) on persistent failure', async () => {
      fetchSpy.mockRejectedValue(makeNetworkError('connection reset', 'ECONNRESET'));

      await expect(build({ maxRetries: 3 })('https://api.example.com/thing')).rejects.toThrow(
        'connection reset',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('rethrows a non-transient error immediately without retrying', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('boom'));

      await expect(build()('https://api.example.com/thing')).rejects.toThrow('boom');
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(sleeps).toEqual([]);
    });

    it('doubles the network-error backoff on each retry', async () => {
      fetchSpy
        .mockRejectedValueOnce(makeNetworkError('fetch failed', 'ETIMEDOUT'))
        .mockRejectedValueOnce(makeNetworkError('fetch failed', 'ETIMEDOUT'))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ backoffBaseMs: 100, random: () => 1 })('https://api.example.com/thing');

      expect(sleeps.slice(0, 2)).toEqual([100, 200]);
    });
  });

  // ---------------------------------------------------------------------------
  // Request timeout (#357)
  // ---------------------------------------------------------------------------
  describe('request timeout', () => {
    function timeoutError(): DOMException {
      return new DOMException('The operation timed out.', 'TimeoutError');
    }

    it('attaches a timeout signal to every fetch', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200));

      await build()('https://api.example.com/thing');

      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('composes a caller-supplied signal with the timeout signal', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200));
      const callerSignal = new AbortController().signal;

      await build()('https://api.example.com/thing', { signal: callerSignal });

      const passed = fetchSpy.mock.calls[0]?.[1]?.signal;
      expect(passed).toBeInstanceOf(AbortSignal);
      // A composite (AbortSignal.any) — not the caller's signal handed through verbatim.
      expect(passed).not.toBe(callerSignal);
    });

    it('builds a fresh signal per attempt (not one reused across retries)', async () => {
      fetchSpy
        .mockRejectedValueOnce(makeNetworkError('connection reset', 'ECONNRESET'))
        .mockResolvedValueOnce(makeResponse(200));

      await build()('https://api.example.com/thing');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).not.toBe(fetchSpy.mock.calls[1]?.[1]?.signal);
    });

    it('fails fast on a timeout — no retry, original error rethrown, warned', async () => {
      fetchSpy.mockRejectedValue(timeoutError());

      await expect(build()('https://api.example.com/thing')).rejects.toThrow('timed out');
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(sleeps).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out after'));
    });

    it('records a timeout as a transient breaker outcome, exactly once', async () => {
      fetchSpy.mockRejectedValue(timeoutError());
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      const recordSpy = vi.spyOn(breaker, 'record');

      await expect(build({ breaker })('https://api.example.com/thing')).rejects.toThrow(
        'timed out',
      );

      expect(recordSpy).toHaveBeenCalledExactlyOnceWith('transient');
      expect(breaker.snapshot().state).toBe('closed'); // transient never trips
      expect(fetchSpy).toHaveBeenCalledOnce(); // fail-fast — not retried
    });
  });

  // ---------------------------------------------------------------------------
  // shouldRetryResponse hook
  // ---------------------------------------------------------------------------
  describe('shouldRetryResponse hook', () => {
    const retryOkHtml = (res: Response): string | null =>
      res.ok && (res.headers.get('content-type') ?? '').includes('text/html')
        ? 'HTML response'
        : null;

    it('retries a response the hook flags, on the shared budget', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(200, { 'content-type': 'text/html' }))
        .mockResolvedValueOnce(makeResponse(200, { 'content-type': 'application/json' }));

      const result = await build({ shouldRetryResponse: retryOkHtml })(
        'https://api.example.com/thing',
      );

      expect(result.headers.get('content-type')).toBe('application/json');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTML response'));
    });

    it('throws RetriesExhaustedError when the hook keeps flagging every attempt', async () => {
      fetchSpy.mockResolvedValue(makeResponse(200, { 'content-type': 'text/html' }));

      await expect(
        build({ maxRetries: 3, shouldRetryResponse: retryOkHtml })('https://api.example.com/thing'),
      ).rejects.toBeInstanceOf(RetriesExhaustedError);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('is not consulted when the status already matched retryStatuses', async () => {
      const hook = vi.fn().mockReturnValue(null);
      fetchSpy.mockResolvedValueOnce(makeResponse(429)).mockResolvedValueOnce(makeResponse(200));

      await build({ shouldRetryResponse: hook })('https://api.example.com/thing');

      // Called once for the accepted 200, never for the 429.
      expect(hook).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
    });
  });

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------
  describe('logging', () => {
    it('prefixes warnings with the label and names the retry reason per status', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429))
        .mockResolvedValueOnce(makeResponse(503))
        .mockResolvedValueOnce(makeResponse(502))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ retryStatuses: [429, 502, 503] })('https://api.example.com/thing');

      expect(warn).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('[test-client] Rate limited (429) on attempt 1/4'),
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('[test-client] Service unavailable (503) on attempt 2/4'),
      );
      expect(warn).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('[test-client] HTTP error (502) on attempt 3/4'),
      );
    });

    it('reports the jittered wait in the warning', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeResponse(429, { 'Retry-After': '5' }))
        .mockResolvedValueOnce(makeResponse(200));

      await build({ random: () => 1 })('https://api.example.com/thing');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('waiting 5000ms'));
    });

    it('uses a setTimeout-based sleep by default (existing client tests rely on this)', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: () => void,
      ) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      fetchSpy.mockResolvedValueOnce(makeResponse(200));

      const rlFetch = createRateLimitedFetch({
        label: 'test-client',
        apiName: 'Test API',
        delayMs: 250,
        maxRetries: 0,
        backoffBaseMs: 0,
        retryStatuses: [429],
      });
      await rlFetch('https://api.example.com/thing');

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250);
      setTimeoutSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Circuit breaker integration (#242)
  // ---------------------------------------------------------------------------
  describe('circuit breaker', () => {
    it('short-circuits without a network call when the breaker is open', async () => {
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      breaker.record('fatal'); // opens it

      await expect(build({ breaker })('https://api.example.com/thing')).rejects.toBeInstanceOf(
        CircuitBreakerOpenError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('records success on an ok response', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse(200));
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      const recordSpy = vi.spyOn(breaker, 'record');

      await build({ breaker })('https://api.example.com/thing');

      expect(recordSpy).toHaveBeenCalledExactlyOnceWith('success');
    });

    it('records fatal on a non-retryable 403 (and trips at threshold)', async () => {
      fetchSpy.mockResolvedValue(makeResponse(403));
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 2,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });

      await build({ breaker })('https://api.example.com/a'); // returned as-is (403 not retried)
      expect(breaker.snapshot().state).toBe('closed');
      await build({ breaker })('https://api.example.com/b');
      expect(breaker.snapshot().state).toBe('open');
      expect(breaker.snapshot().fatalCount).toBe(2);
    });

    it('records miss on a 404 (never trips)', async () => {
      fetchSpy.mockResolvedValue(makeResponse(404));
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      const recordSpy = vi.spyOn(breaker, 'record');

      await build({ breaker })('https://api.example.com/thing');

      expect(recordSpy).toHaveBeenCalledExactlyOnceWith('miss');
      expect(breaker.snapshot().state).toBe('closed');
    });

    it('records transient when retryable responses exhaust the budget', async () => {
      fetchSpy.mockResolvedValue(makeResponse(429));
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      const recordSpy = vi.spyOn(breaker, 'record');

      await expect(
        build({ breaker, maxRetries: 2 })('https://api.example.com/thing'),
      ).rejects.toThrow(RetriesExhaustedError);

      expect(recordSpy).toHaveBeenCalledExactlyOnceWith('transient');
      expect(breaker.snapshot().state).toBe('closed'); // transient never trips
    });

    it('records transient when a transient network error exhausts the budget', async () => {
      fetchSpy.mockRejectedValue(makeNetworkError('connection reset', 'ECONNRESET'));
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      const recordSpy = vi.spyOn(breaker, 'record');

      await expect(
        build({ breaker, maxRetries: 1 })('https://api.example.com/thing'),
      ).rejects.toThrow('connection reset');

      expect(recordSpy).toHaveBeenCalledExactlyOnceWith('transient');
    });

    it('does NOT record on a non-transient fetch throw', async () => {
      fetchSpy.mockRejectedValue(new TypeError('boom'));
      const breaker = new CircuitBreaker({
        source: 'test',
        threshold: 1,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      });
      const recordSpy = vi.spyOn(breaker, 'record');

      await expect(build({ breaker })('https://api.example.com/thing')).rejects.toThrow('boom');

      expect(recordSpy).not.toHaveBeenCalled();
    });
  });
});
