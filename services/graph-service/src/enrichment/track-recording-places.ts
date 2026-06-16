import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient, MbRecordingPlace } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getTracksForRecordingPlacesEnrichment,
  mergeRecordingPlaces,
  setRecordingPlacesFetched,
  type RecordingForPlaces,
} from '../db/track-recording-places-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export interface TrackRecordingPlacesEnrichmentSummary {
  recordingsProcessed: number;
  recordingsSkipped: number;
  recordingsFailed: number;
  studioEdges: number;
  durationMs: number;
}

/** The studios for a recording, deduped to one per Studio name, ready to MERGE. */
type ResolvedPlaces = { places: MbRecordingPlace[] };

/**
 * Collapse a recording's place relations to one entry per Studio name (#339, slice 2). A recording
 * can carry several place relations (e.g. `recorded at` and `mixed at`); when two point at the SAME
 * studio name they would MERGE to the same `(:Track)-[:RECORDED_AT]->(:Studio)` edge anyway (one edge
 * per (Track, Studio)), so the first relation seen wins — distinct studio names are all kept.
 */
function dedupePlacesByName(places: MbRecordingPlace[]): MbRecordingPlace[] {
  const byName = new Map<string, MbRecordingPlace>();
  for (const place of places) {
    if (!byName.has(place.name)) byName.set(place.name, place);
  }
  return [...byName.values()];
}

/**
 * Attribute MusicBrainz recording-level studios to the specific Track (#339, slice 2), a deterministic
 * per-track studio source Discogs (album-level only) cannot give. For each distinct `recordingMbid`
 * (resolved earlier by `track-musicbrainz`):
 *   1. `GET /recording/{mbid}?inc=place-rels` → its `recorded at` / `mixed at` Place relations.
 *   2. Write track-scoped `(:Track)-[:RECORDED_AT {source:"musicbrainz"}]->(:Studio)` edges, MERGEing
 *      the Studio by name onto the existing name-keyed nodes and enriching it with the Place's
 *      coordinates / area for the recording-location map (#342).
 *
 * Stamp-on-attempt (#89): every candidate Track is stamped `recordingPlacesFetchedAt` even when a
 * recording has no place relations, so it is retried at most once per staleness window; a thrown error
 * leaves it unstamped to retry next run.
 *
 * Unlike `track-recording-artists`, this stage emits NO "0 edges" warning: MusicBrainz place relations
 * are genuinely sparse, so zero studios across a whole collection is legitimate, not a broken fetch —
 * a fail-style warn here would cry wolf every reload. A broken `place-rels` fetch surfaces instead as
 * throwing fetches in the `recordingsFailed` count (and the parse is pinned by a fixture unit test).
 * The info line below records the yield so it is a known number, never a silent zero.
 */
export async function enrichTrackRecordingPlaces(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<TrackRecordingPlacesEnrichmentSummary> {
  const log: Logger = logger ?? console;
  let studioEdges = 0;
  let candidateCount = 0;

  const stage: EnrichmentStage<RecordingForPlaces, ResolvedPlaces> = {
    name: 'track-recording-places',
    async selectCandidates(d) {
      const recordings = await getTracksForRecordingPlacesEnrichment(d);
      candidateCount = recordings.length;
      return recordings;
    },
    async resolve({ recordingMbid }) {
      const places = dedupePlacesByName(await mbClient.getPlacesByRecordingMbid(recordingMbid));
      if (places.length === 0) return null;
      return { places };
    },
    async write(d, { recordingMbid, trackElementIds }, resolved) {
      await mergeRecordingPlaces(d, recordingMbid, trackElementIds, resolved.places);
      studioEdges += trackElementIds.length * resolved.places.length;
    },
    markAttempted: (d, { trackElementIds }) => setRecordingPlacesFetched(d, trackElementIds),
    describeItem: ({ recordingMbid }) => `recording ${recordingMbid}`,
    progressEveryItems: 10,
  };

  const summary = await runEnrichment(driver, stage, { logger: log, onProgress });

  log.info(
    `[track-recording-places] ${candidateCount} recording(s), ${studioEdges} RECORDED_AT edge(s) written (place relations are sparse by design — 0 is legitimate; processed=${summary.enriched}, skipped=${summary.skipped}, failed=${summary.failed}).`,
  );

  return {
    recordingsProcessed: summary.enriched,
    recordingsSkipped: summary.skipped,
    recordingsFailed: summary.failed,
    studioEdges,
    durationMs: summary.durationMs,
  };
}
