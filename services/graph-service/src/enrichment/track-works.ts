import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient, MbWorkWriter } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getTracksForWorksEnrichment,
  mergeTrackWorks,
  setTrackWorksFetched,
  type RecordingForWorks,
  type WorkToMerge,
} from '../db/track-works-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface TrackWorksEnrichmentSummary {
  recordingsProcessed: number;
  recordingsSkipped: number;
  recordingsFailed: number;
  worksWritten: number;
  recordingOfEdges: number;
  durationMs: number;
}

/** The Work(s) a recording is a performance of, ready to MERGE. */
type ResolvedWorks = { works: WorkToMerge[] };

/**
 * Link Track nodes to the MusicBrainz Work (composition) they are a recording of (#336).
 *
 * For each distinct `recordingMbid` (resolved earlier by `track-musicbrainz`):
 *   1. `GET /recording/{mbid}?inc=work-rels` → the Work(s) it performs (ground truth; no matching).
 *   2. For each Work, `GET /work/{mbid}?inc=artist-rels` → its writers, captured on the Work node.
 *
 * Two Tracks that are RECORDING_OF the same Work but are different recordings are versions/covers;
 * the same recording on two releases is just a duplicate — the shared Work MBID is the only signal,
 * so there is nothing to mis-match.
 *
 * Stamp-on-attempt (#89): every candidate Track is stamped `worksFetchedAt` even when MusicBrainz
 * has no Work, so it is retried at most once per staleness window; a thrown error leaves it unstamped
 * to retry next run. Per-distinct-Work writer lookups are memoized for the run, so a Work shared
 * across covers is fetched once.
 */
export async function enrichTrackWorks(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<TrackWorksEnrichmentSummary> {
  const log: Logger = logger ?? console;
  // Distinct Work MBIDs actually MERGEd this run — a Work shared across recordings (the cover
  // case) is counted once, not once per recording.
  const writtenWorkMbids = new Set<string>();
  let recordingOfEdges = 0;
  let candidateCount = 0;

  // Per-run cache: a Work shared by several recordings (the cover case) is fetched once.
  const writerCache = new Map<string, MbWorkWriter[]>();

  const stage: EnrichmentStage<RecordingForWorks, ResolvedWorks> = {
    name: 'track-works',
    async selectCandidates(d) {
      const recordings = await getTracksForWorksEnrichment(d);
      candidateCount = recordings.length;
      return recordings;
    },
    async resolve({ recordingMbid }) {
      const works = await mbClient.getWorksByRecordingMbid(recordingMbid);
      if (works.length === 0) return null;

      const resolved: WorkToMerge[] = [];
      for (const work of works) {
        let writers = writerCache.get(work.mbid);
        if (writers === undefined) {
          writers = await mbClient.getWritersByWorkMbid(work.mbid);
          // Cache only a non-empty result. getWritersByWorkMbid returns [] when the circuit
          // breaker is open (transient), so caching [] would poison every later recording of a
          // shared Work for the rest of the run, permanently leaving it writer-less. A genuinely
          // writer-less Work just re-fetches — cheap, since such Works are rare and usually appear once.
          if (writers.length > 0) writerCache.set(work.mbid, writers);
        }
        resolved.push({ mbid: work.mbid, title: work.title, type: work.type, writers });
      }
      return { works: resolved };
    },
    async write(d, { trackElementIds }, resolved) {
      await mergeTrackWorks(d, trackElementIds, resolved.works);
      for (const w of resolved.works) writtenWorkMbids.add(w.mbid);
      recordingOfEdges += trackElementIds.length * resolved.works.length;
    },
    markAttempted: (d, { trackElementIds }) => setTrackWorksFetched(d, trackElementIds),
    describeItem: ({ recordingMbid }) => `recording ${recordingMbid}`,
    progressEveryItems: 10,
  };

  const summary = await runEnrichment(driver, stage, { logger: log, onProgress });

  if (candidateCount > 0 && summary.failed === 0 && recordingOfEdges === 0) {
    log.warn(
      `[track-works] No-op: ${candidateCount} recording(s) found, 0 failures, but 0 RECORDING_OF edges written (processed=${summary.enriched}, skipped=${summary.skipped}). Expected >0 — verify the MusicBrainz recording→work lookup before treating this as complete.`,
    );
  }

  return {
    recordingsProcessed: summary.enriched,
    recordingsSkipped: summary.skipped,
    recordingsFailed: summary.failed,
    worksWritten: writtenWorkMbids.size,
    recordingOfEdges,
    durationMs: summary.durationMs,
  };
}
