import { randomUUID } from 'crypto';

export type JobStatus = 'idle' | 'running' | 'complete' | 'failed';

export interface IngestionStats {
  nodes: Record<string, number>;
  relationships: Record<string, number>;
  lyricsEnriched: number;
  lyricsSkipped: number;
  lyricsFailed: number;
  errorCount: number;
  errors: string[];
}

export interface JobState {
  status: JobStatus;
  jobId: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  stats: IngestionStats | null;
}

let state: JobState = {
  status: 'idle',
  jobId: '',
  startedAt: null,
  completedAt: null,
  durationMs: null,
  stats: null,
};

export function getJobState(): JobState {
  return structuredClone(state);
}

export function startJob(): string {
  const jobId = randomUUID();
  state = {
    status: 'running',
    jobId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    stats: null,
  };
  return jobId;
}

export function completeJob(stats: IngestionStats): void {
  const now = new Date();
  const durationMs = state.startedAt ? now.getTime() - new Date(state.startedAt).getTime() : null;
  state = {
    ...state,
    status: 'complete',
    completedAt: now.toISOString(),
    durationMs,
    stats,
  };
}

export function failJob(error: string): void {
  const now = new Date();
  const durationMs = state.startedAt ? now.getTime() - new Date(state.startedAt).getTime() : null;
  state = {
    ...state,
    status: 'failed',
    completedAt: now.toISOString(),
    durationMs,
    stats: {
      nodes: {},
      relationships: {},
      lyricsEnriched: 0,
      lyricsSkipped: 0,
      lyricsFailed: 0,
      errorCount: 1,
      errors: [error],
    },
  };
}
