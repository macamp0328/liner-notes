import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient, MbRecordingArtist } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getTracksForRecordingArtistsEnrichment,
  mergeRecordingArtistCredits,
  setRecordingArtistsFetched,
  type RecordingForArtists,
  type RecordingArtistCredit,
} from '../db/track-recording-artists-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface TrackRecordingArtistsEnrichmentSummary {
  recordingsProcessed: number;
  recordingsSkipped: number;
  recordingsFailed: number;
  creditEdges: number;
  durationMs: number;
}

/** The track-attributable credits for a recording, one per distinct person, ready to MERGE. */
type ResolvedCredits = { credits: RecordingArtistCredit[] };

/**
 * Collapse a recording's raw relations into one credit per person (#335, #339). MusicBrainz emits a
 * separate relation per instrument/vocal/performer role (and per production role), so one person can
 * appear several times; we group by their MB artist MBID and join their distinct role tokens into a
 * single `role` string — matching the one-`CREDITED_ON`-per-(person,track) model rather than
 * collapsing a multi-role credit arbitrarily. A relation's token is each of its `attributes` (the
 * instrument/vocal name), or the bare `role` when it carries none — which is every production credit,
 * whose canonical role string the client already resolved with attributes dropped (#339).
 */
function groupCreditsByArtist(relations: MbRecordingArtist[]): RecordingArtistCredit[] {
  const byMbid = new Map<string, { name: string; tokens: string[] }>();
  for (const rel of relations) {
    const entry = byMbid.get(rel.mbid) ?? { name: rel.name, tokens: [] };
    const tokens = rel.attributes.length > 0 ? rel.attributes : [rel.role];
    for (const token of tokens) {
      if (token !== '' && !entry.tokens.includes(token)) entry.tokens.push(token);
    }
    byMbid.set(rel.mbid, entry);
  }
  return [...byMbid.entries()].map(([mbid, { name, tokens }]) => ({
    mbid,
    name,
    role: tokens.join(', '),
  }));
}

/**
 * Push MusicBrainz recording-level performance and production credits down to the specific Track
 * (#335, #339), increasing track-credit coverage from a deterministic source. For each distinct
 * `recordingMbid` (resolved earlier by `track-musicbrainz`):
 *   1. `GET /recording/{mbid}?inc=artist-rels` → its performer/instrument/vocal relations plus the
 *      producer + engineer-family production relations (each provably tied to that exact recording;
 *      mastering/lacquer/cover-art and other non-production roles are excluded by the client).
 *   2. Group them per person and write track-scoped `CREDITED_ON` edges, resolving each person by the
 *      MB-artist-MBID join the `mb-artist-id` pass established (#380) — never name/title matching.
 *
 * Stamp-on-attempt (#89): every candidate Track is stamped `recordingArtistsFetchedAt` even when a
 * recording has no performance relations, so it is retried at most once per staleness window; a thrown
 * error leaves it unstamped to retry next run. This stage depends on both `track-musicbrainz` (for
 * `recordingMbid`) and `mb-artist-id` (for the `musicbrainzId` join — running it first is what stops
 * every credit from spawning a duplicate fallback person).
 */
export async function enrichTrackRecordingArtists(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<TrackRecordingArtistsEnrichmentSummary> {
  const log: Logger = logger ?? console;
  let creditEdges = 0;
  let candidateCount = 0;

  const stage: EnrichmentStage<RecordingForArtists, ResolvedCredits> = {
    name: 'track-recording-artists',
    async selectCandidates(d) {
      const recordings = await getTracksForRecordingArtistsEnrichment(d);
      candidateCount = recordings.length;
      return recordings;
    },
    async resolve({ recordingMbid }) {
      const relations = await mbClient.getArtistsByRecordingMbid(recordingMbid);
      const credits = groupCreditsByArtist(relations);
      if (credits.length === 0) return null;
      return { credits };
    },
    async write(d, { recordingMbid, trackElementIds }, resolved) {
      await mergeRecordingArtistCredits(d, recordingMbid, trackElementIds, resolved.credits);
      creditEdges += trackElementIds.length * resolved.credits.length;
    },
    markAttempted: (d, { trackElementIds }) => setRecordingArtistsFetched(d, trackElementIds),
    describeItem: ({ recordingMbid }) => `recording ${recordingMbid}`,
    progressEveryItems: 10,
  };

  const summary = await runEnrichment(driver, stage, { logger: log, onProgress });

  if (candidateCount > 0 && summary.failed === 0 && creditEdges === 0) {
    log.warn(
      `[track-recording-artists] No-op: ${candidateCount} recording(s) found, 0 failures, but 0 CREDITED_ON edges written (processed=${summary.enriched}, skipped=${summary.skipped}). Expected >0 — verify the MusicBrainz recording artist-rels lookup before treating this as complete.`,
    );
  }

  return {
    recordingsProcessed: summary.enriched,
    recordingsSkipped: summary.skipped,
    recordingsFailed: summary.failed,
    creditEdges,
    durationMs: summary.durationMs,
  };
}
