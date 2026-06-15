import type { Driver } from 'neo4j-driver';
import type { MusicBrainzClient } from '../ingestion/musicbrainz-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedArtistsForMbid,
  getUnenrichedMusiciansForMbid,
  setArtistMusicbrainzId,
  setMusicianMusicbrainzId,
  type UnmappedPerson,
} from '../db/artist-musicbrainz-id-repository.js';
import { runEnrichment, type EnrichmentStage } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

/** The resolved MusicBrainz artist MBID for a person node. */
type ResolvedMbid = { musicbrainzId: string };

export interface MusicbrainzIdEnrichmentSummary {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

/**
 * Resolve the MusicBrainz artist MBID for each Artist and Musician node (via the Discogs-URL
 * relation) and store it as `musicbrainzId` (#380). This is the deterministic Discogs↔MB-artist
 * identity mapping that the `songwriter-reconciliation` pass joins on to promote each Work's
 * captured `writerMbids` to real `WROTE` edges — no name-matching, ID join only.
 *
 * Runs as two sequential `runEnrichment` stages — Artists, then Musicians — mirroring nationality.
 * A node MusicBrainz has no Discogs link for resolves to `null` → throttled-recheck (stamp only),
 * retried at most once per staleness window (never terminal: an MB editor may add the link later).
 *
 * Ordered before `nationality` in the reload so nationality can reuse the stored MBID and skip its
 * own `/url` lookup — net-zero MusicBrainz calls across the two stages for resolvable nodes.
 */
export async function enrichArtistMusicbrainzIds(
  mbClient: MusicBrainzClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<MusicbrainzIdEnrichmentSummary> {
  const log: Logger = logger ?? console;
  const startTime = Date.now();

  const resolve = async (person: UnmappedPerson): Promise<ResolvedMbid | null> => {
    const mbid = await mbClient.resolveArtistMbidByDiscogsId(person.discogsId);
    return mbid !== null ? { musicbrainzId: mbid } : null;
  };

  // The musician count isn't known until the artist phase finishes, so the reported denominator
  // grows when the musician stage begins (same pattern as artist-nationality).
  let artistTotal = 0;

  const artistStage: EnrichmentStage<UnmappedPerson, ResolvedMbid> = {
    name: 'mb-artist-id',
    async selectCandidates(d) {
      const artists = await getUnenrichedArtistsForMbid(d);
      artistTotal = artists.length;
      return artists;
    },
    resolve,
    write: (d, person, resolved) =>
      setArtistMusicbrainzId(d, person.discogsId, resolved.musicbrainzId),
    markAttempted: (d, person) => setArtistMusicbrainzId(d, person.discogsId, null),
    describeItem: (person) => `artist ${person.discogsId}`,
  };

  const artistSummary = await runEnrichment(driver, artistStage, {
    logger: log,
    // Swallow the artist stage's final 100% report — the musician stage immediately re-reports
    // against the grown denominator, avoiding a momentary 100% blip.
    onProgress: (i, total) => {
      if (total > 0 && i === total) return;
      onProgress(i, total);
    },
  });

  const musicianStage: EnrichmentStage<UnmappedPerson, ResolvedMbid> = {
    name: 'mb-artist-id',
    selectCandidates: (d) => getUnenrichedMusiciansForMbid(d),
    resolve,
    write: (d, person, resolved) =>
      setMusicianMusicbrainzId(d, person.discogsId, resolved.musicbrainzId),
    markAttempted: (d, person) => setMusicianMusicbrainzId(d, person.discogsId, null),
    describeItem: (person) => `musician ${person.discogsId}`,
  };

  const musicianSummary = await runEnrichment(driver, musicianStage, {
    logger: log,
    onProgress: (i, total) => onProgress(artistTotal + i, artistTotal + total),
  });

  return {
    enriched: artistSummary.enriched + musicianSummary.enriched,
    skipped: artistSummary.skipped + musicianSummary.skipped,
    failed: artistSummary.failed + musicianSummary.failed,
    durationMs: Date.now() - startTime,
  };
}
