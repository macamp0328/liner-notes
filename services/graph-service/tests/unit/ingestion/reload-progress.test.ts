import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  markReloadActive,
  markReloadInactive,
  isReloadActive,
  beginStage,
  reportStageProgress,
  getLiveProgress,
  clearStage,
  __resetReloadProgress,
} from '../../../src/ingestion/reload-progress.js';

describe('reload-progress registry', () => {
  beforeEach(() => __resetReloadProgress());

  describe('active flag', () => {
    it('starts inactive and flips on markReloadActive', () => {
      expect(isReloadActive()).toBe(false);
      markReloadActive('job-1');
      expect(isReloadActive()).toBe(true);
    });

    it('markReloadInactive clears only when the jobId matches', () => {
      markReloadActive('job-1');
      markReloadInactive('job-2'); // a stale finally from a superseded run
      expect(isReloadActive()).toBe(true);

      markReloadInactive('job-1');
      expect(isReloadActive()).toBe(false);
    });

    it('markReloadInactive also drops any live stage progress', () => {
      markReloadActive('job-1');
      beginStage('job-1', 'lyrics');
      reportStageProgress('job-1', 'lyrics', 5, 10);
      expect(getLiveProgress()).not.toBeNull();

      markReloadInactive('job-1');
      expect(getLiveProgress()).toBeNull();
    });
  });

  describe('stage progress', () => {
    afterEach(() => vi.useRealTimers());

    it('beginStage resets counters and stamps the ETA clock', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-05T12:00:00.000Z'));

      beginStage('job-1', 'nationality');

      const live = getLiveProgress();
      expect(live).toEqual({
        jobId: 'job-1',
        stage: 'nationality',
        processed: 0,
        total: 0,
        stageStartedAtMs: Date.parse('2026-06-05T12:00:00.000Z'),
      });
    });

    it('reportStageProgress updates the live counters', () => {
      beginStage('job-1', 'lyrics');
      reportStageProgress('job-1', 'lyrics', 25, 100);

      const live = getLiveProgress();
      expect(live?.processed).toBe(25);
      expect(live?.total).toBe(100);
    });

    it('reportStageProgress is a no-op when jobId or stage does not match', () => {
      beginStage('job-1', 'lyrics');
      reportStageProgress('job-2', 'lyrics', 9, 9); // wrong job
      reportStageProgress('job-1', 'master-data', 9, 9); // wrong stage

      const live = getLiveProgress();
      expect(live?.processed).toBe(0);
      expect(live?.total).toBe(0);
    });

    it('reportStageProgress is a no-op when no stage is live', () => {
      reportStageProgress('job-1', 'lyrics', 5, 10);
      expect(getLiveProgress()).toBeNull();
    });

    it('clearStage drops live progress but keeps the active flag', () => {
      markReloadActive('job-1');
      beginStage('job-1', 'lyrics');
      clearStage();

      expect(getLiveProgress()).toBeNull();
      expect(isReloadActive()).toBe(true);
    });
  });
});
