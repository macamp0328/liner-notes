import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient, MbRecordingTrack } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getTracksForMusicBrainzEnrichment,
  setTrackMusicBrainzIds,
} from '../db/track-musicbrainz-repository.js';
import type {
  TrackForMusicBrainz,
  TrackMusicBrainzResult,
} from '../db/track-musicbrainz-repository.js';

export interface TrackMusicBrainzEnrichmentSummary {
  releasesProcessed: number;
  releasesSkipped: number;
  releasesFailed: number;
  tracksMatched: number;
  tracksUnmatched: number;
  durationMs: number;
}

/** Title similarity at or above this value counts the titles as the same track. */
const TITLE_SIMILARITY_THRESHOLD = 0.85;
/** Maximum allowed gap between Discogs and MusicBrainz durations, in seconds. */
const DURATION_TOLERANCE_SECONDS = 5;

/**
 * Normalize a title for comparison: strip diacritics, lowercase, and drop every
 * character that is not a letter or digit. "Café (Take 2)" → "cafetake2".
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i++) {
    grams.push(value.slice(i, i + 2));
  }
  return grams;
}

/**
 * Sørensen–Dice coefficient over character bigrams of the normalized titles.
 * Returns 1 for an exact normalized match and 0 when either title is empty.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;

  const aGrams = bigrams(na);
  const bGrams = bigrams(nb);
  if (aGrams.length === 0 || bGrams.length === 0) return 0;

  const bCounts = new Map<string, number>();
  for (const gram of bGrams) {
    bCounts.set(gram, (bCounts.get(gram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const gram of aGrams) {
    const remaining = bCounts.get(gram) ?? 0;
    if (remaining > 0) {
      intersection++;
      bCounts.set(gram, remaining - 1);
    }
  }

  return (2 * intersection) / (aGrams.length + bGrams.length);
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
 */
export function alignTracklist(
  nodes: TrackForMusicBrainz[],
  mbTracks: MbRecordingTrack[],
): TrackMusicBrainzResult[] {
  const ordered = [...nodes].sort((a, b) => a.trackNumber - b.trackNumber);
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
 * Every processed track is marked musicBrainzFetched = true for idempotency, even
 * when no identifier was found. Failed releases are NOT marked, so they retry.
 */
export async function enrichTrackMusicBrainz(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
): Promise<TrackMusicBrainzEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();
  let releasesProcessed = 0;
  let releasesSkipped = 0;
  let releasesFailed = 0;
  let tracksMatched = 0;
  let tracksUnmatched = 0;

  log.info('[track-musicbrainz] Starting MusicBrainz track identifier enrichment');

  let releases;
  try {
    releases = await getTracksForMusicBrainzEnrichment(driver);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[track-musicbrainz] Failed to fetch releases for enrichment: ${msg}`);
    return {
      releasesProcessed: 0,
      releasesSkipped: 0,
      releasesFailed: 1,
      tracksMatched: 0,
      tracksUnmatched: 0,
      durationMs: Date.now() - startTime,
    };
  }

  log.info(`[track-musicbrainz] Found ${releases.length} releases with unenriched tracks`);

  let i = 0;
  for (const release of releases) {
    if (i > 0 && i % 10 === 0) {
      log.info(
        `[track-musicbrainz] Progress: ${i}/${releases.length} — processed=${releasesProcessed}, skipped=${releasesSkipped}, failed=${releasesFailed}, matched=${tracksMatched}`,
      );
    }
    i++;

    try {
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

      const results: TrackMusicBrainzResult[] = release.tracks.map((track) => {
        const match = matchByElementId.get(track.elementId);
        return {
          elementId: track.elementId,
          recordingMbid: match?.recordingMbid ?? null,
          isrc: match?.isrc ?? null,
        };
      });

      await setTrackMusicBrainzIds(driver, results);

      const matched = matchByElementId.size;
      tracksMatched += matched;
      tracksUnmatched += release.tracks.length - matched;

      if (matched > 0) {
        releasesProcessed++;
      } else {
        releasesSkipped++;
        log.info(
          `[track-musicbrainz] No MusicBrainz matches for release ${release.releaseDiscogsId}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[track-musicbrainz] Failed for release ${release.releaseDiscogsId}: ${msg}`);
      releasesFailed++;
    }
  }

  const durationMs = Date.now() - startTime;
  log.info(
    `[track-musicbrainz] Enrichment complete: processed=${releasesProcessed}, skipped=${releasesSkipped}, failed=${releasesFailed}, tracksMatched=${tracksMatched}, tracksUnmatched=${tracksUnmatched}, duration=${durationMs}ms`,
  );

  return {
    releasesProcessed,
    releasesSkipped,
    releasesFailed,
    tracksMatched,
    tracksUnmatched,
    durationMs,
  };
}
