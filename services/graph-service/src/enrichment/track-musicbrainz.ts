import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient, MbRecordingTrack } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import { parsePosition } from '../ingestion/transforms.js';
import {
  getTracksForMusicBrainzEnrichment,
  setTrackMusicBrainzIds,
} from '../db/track-musicbrainz-repository.js';
import type {
  ReleaseForMusicBrainz,
  TrackForMusicBrainz,
  TrackMusicBrainzResult,
} from '../db/track-musicbrainz-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';
import {
  normalizeForMatch,
  titleSimilarity,
  TITLE_SIMILARITY_THRESHOLD,
  DURATION_TOLERANCE_SECONDS,
} from './match-confidence.js';

// Re-exported so existing importers (and tests) keep resolving them here; the canonical
// home is now `match-confidence.js`, shared with the lyrics gate (#248).
export { normalizeForMatch, titleSimilarity };

export interface TrackMusicBrainzEnrichmentSummary {
  releasesProcessed: number;
  releasesSkipped: number;
  releasesFailed: number;
  tracksMatched: number;
  tracksUnmatched: number;
  durationMs: number;
}

/**
 * Decide whether a Track node and a MusicBrainz track are the same recording.
 *
 * Titles must clear the similarity threshold. When both durations are known the
 * gap must be within tolerance; when a duration is missing, the looser duration
 * signal is replaced by requiring an exact normalized title match. A false return
 * means "skip" — a guessed MBID poisons every downstream enrichment.
 */
export function isValidMatch(
  node: { title: string; durationSeconds: number | null },
  mbTrack: { title: string; lengthSeconds: number | null },
): boolean {
  const similarity = titleSimilarity(node.title, mbTrack.title);
  if (similarity < TITLE_SIMILARITY_THRESHOLD) return false;

  if (node.durationSeconds !== null && mbTrack.lengthSeconds !== null) {
    return Math.abs(node.durationSeconds - mbTrack.lengthSeconds) <= DURATION_TOLERANCE_SECONDS;
  }

  return similarity === 1;
}

/**
 * Align a release's Track nodes to a MusicBrainz tracklist by ordinal position,
 * validating every pair. Only validated pairs are returned — unmatched or
 * mismatched tracks are silently dropped rather than assigned a guessed MBID.
 *
 * Nodes are sorted into album order by their parsed Discogs position (side/disc
 * prefix, then track number) rather than a stored ordinal — the numeric portion of
 * a vinyl position restarts at 1 on every side and is not release-unique.
 */
export function alignTracklist(
  nodes: TrackForMusicBrainz[],
  mbTracks: MbRecordingTrack[],
): TrackMusicBrainzResult[] {
  const numericCollator = new Intl.Collator(undefined, { numeric: true });
  const ordered = [...nodes].sort((a, b) => {
    const pa = parsePosition(a.position);
    const pb = parsePosition(b.position);
    return numericCollator.compare(pa.prefix, pb.prefix) || pa.num - pb.num;
  });
  const matches: TrackMusicBrainzResult[] = [];
  const mbIterator = mbTracks[Symbol.iterator]();

  for (const node of ordered) {
    const next = mbIterator.next();
    if (next.done === true) break;
    const mbTrack = next.value;
    if (isValidMatch(node, mbTrack)) {
      matches.push({
        elementId: node.elementId,
        recordingMbid: mbTrack.recordingMbid,
        isrc: mbTrack.isrc,
      });
    }
  }

  return matches;
}

/**
 * Enrich Track nodes with MusicBrainz recording MBID + ISRC.
 *
 * For each Release with unenriched tracks:
 *   1. Resolve the MusicBrainz release via the Discogs URL relation, fetch its
 *      tracklist with recording IDs/ISRCs, and align by validated ordinal position.
 *   2. For any track left unmatched, fall back to a direct recording search
 *      (accepted only on a high MusicBrainz score).
 *
 * Every processed track is stamped musicBrainzFetchedAt even when no identifier was found,
 * so a track with no MusicBrainz match is retried at most once per staleness window. Failed
 * releases are NOT stamped, so they retry on the next run.
 */
/** The per-release alignment outcome: identifiers for every track, nulls for unmatched. */
type ResolvedTrackIds = { results: TrackMusicBrainzResult[]; matchedCount: number };

export async function enrichTrackMusicBrainz(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<TrackMusicBrainzEnrichmentSummary> {
  const log: Logger = logger ?? console;
  let tracksMatched = 0;
  let tracksUnmatched = 0;

  const stage: EnrichmentStage<ReleaseForMusicBrainz, ResolvedTrackIds> = {
    name: 'track-musicbrainz',
    selectCandidates: (d) => getTracksForMusicBrainzEnrichment(d),
    async resolve(release) {
      const matchByElementId = new Map<string, { recordingMbid: string; isrc: string | null }>();

      // Primary path: Discogs release → MusicBrainz release → aligned tracklist.
      const mbReleaseId = await mbClient.getReleaseMbidByDiscogsReleaseId(release.releaseDiscogsId);
      if (mbReleaseId !== null) {
        const mbTracks = await mbClient.getRecordingsByReleaseMbid(mbReleaseId);
        for (const match of alignTracklist(release.tracks, mbTracks)) {
          matchByElementId.set(match.elementId, {
            recordingMbid: match.recordingMbid!,
            isrc: match.isrc,
          });
        }
      }

      // Fallback path: direct recording search for any track still unmatched.
      const artist = release.artistNames[0] ?? null;
      if (artist !== null) {
        for (const track of release.tracks) {
          if (matchByElementId.has(track.elementId)) continue;
          const found = await mbClient.searchRecording(track.title, artist, track.durationSeconds);
          if (found !== null) {
            matchByElementId.set(track.elementId, found);
          }
        }
      }

      if (matchByElementId.size === 0) {
        log.info(
          `[track-musicbrainz] No MusicBrainz matches for release ${release.releaseDiscogsId}`,
        );
        return null;
      }

      const results: TrackMusicBrainzResult[] = release.tracks.map((track) => {
        const match = matchByElementId.get(track.elementId);
        return {
          elementId: track.elementId,
          recordingMbid: match?.recordingMbid ?? null,
          isrc: match?.isrc ?? null,
        };
      });

      return { results, matchedCount: matchByElementId.size };
    },
    async write(d, release, resolved) {
      await setTrackMusicBrainzIds(d, resolved.results);
      // Tallied only after a successful write — a failed release leaves its tracks uncounted.
      tracksMatched += resolved.matchedCount;
      tracksUnmatched += release.tracks.length - resolved.matchedCount;
    },
    // No matches anywhere — stamp every track with null identifiers so the release isn't
    // re-fetched until the staleness window expires.
    async markAttempted(d, release) {
      await setTrackMusicBrainzIds(
        d,
        release.tracks.map((track) => ({
          elementId: track.elementId,
          recordingMbid: null,
          isrc: null,
        })),
      );
      tracksUnmatched += release.tracks.length;
    },
    describeItem: (release) => `release ${release.releaseDiscogsId}`,
    progressEveryItems: 10,
  };

  const summary = await runEnrichment(driver, stage, { logger: log, onProgress });

  return {
    releasesProcessed: summary.enriched,
    releasesSkipped: summary.skipped,
    releasesFailed: summary.failed,
    tracksMatched,
    tracksUnmatched,
    durationMs: summary.durationMs,
  };
}
