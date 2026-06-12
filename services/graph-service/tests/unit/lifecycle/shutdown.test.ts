import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getShutdownSignal,
  isShuttingDown,
  requestShutdown,
  trackBackgroundJob,
  drainBackgroundJobs,
  __resetShutdown,
} from '../../../src/lifecycle/shutdown.js';

describe('shutdown lifecycle (#291)', () => {
  afterEach(() => {
    __resetShutdown();
    vi.useRealTimers();
  });

  describe('abort signal', () => {
    it('starts un-aborted and flips on requestShutdown', () => {
      expect(isShuttingDown()).toBe(false);
      expect(getShutdownSignal().aborted).toBe(false);

      requestShutdown();

      expect(isShuttingDown()).toBe(true);
      expect(getShutdownSignal().aborted).toBe(true);
    });

    it('is idempotent — a second requestShutdown does not throw', () => {
      requestShutdown();
      expect(() => requestShutdown()).not.toThrow();
      expect(isShuttingDown()).toBe(true);
    });

    it('__resetShutdown restores a fresh, un-aborted signal', () => {
      requestShutdown();
      expect(isShuttingDown()).toBe(true);

      __resetShutdown();

      expect(isShuttingDown()).toBe(false);
      expect(getShutdownSignal().aborted).toBe(false);
    });
  });

  describe('drain registry', () => {
    it('drains immediately when nothing is tracked', async () => {
      const result = await drainBackgroundJobs(1000);
      expect(result).toEqual({ drained: true, pending: 0 });
    });

    it('waits for a tracked job to settle, then reports drained', async () => {
      let resolveJob!: () => void;
      const job = new Promise<void>((res) => {
        resolveJob = res;
      });
      trackBackgroundJob(job);

      const drainPromise = drainBackgroundJobs(1000);
      resolveJob();
      const result = await drainPromise;

      expect(result.drained).toBe(true);
      expect(result.pending).toBe(0);
    });

    it('auto-untracks a job that already settled', async () => {
      const job = Promise.resolve();
      trackBackgroundJob(job);
      await job;
      // Let the then(untrack) microtask run before draining.
      await Promise.resolve();

      const result = await drainBackgroundJobs(1000);
      expect(result).toEqual({ drained: true, pending: 0 });
    });

    it('still drains (and does not reject) when a tracked job rejects', async () => {
      trackBackgroundJob(Promise.reject(new Error('boom')));

      const result = await drainBackgroundJobs(1000);

      expect(result.drained).toBe(true);
    });

    it('times out and reports the pending count when a job never settles', async () => {
      vi.useFakeTimers();
      trackBackgroundJob(new Promise<void>(() => {})); // never settles

      const drainPromise = drainBackgroundJobs(5000);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await drainPromise;

      expect(result.drained).toBe(false);
      expect(result.pending).toBe(1);
    });
  });
});
