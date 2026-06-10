import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedArtists,
  setArtistProfile,
  type UnenrichedArtist,
} from '../db/artist-profiles-repository.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export type ArtistProfilesEnrichmentSummary = EnrichmentSummary;

/** Profile data resolved from the Discogs artist endpoint; absent fields normalized to null. */
type ResolvedProfile = { realName: string | null; profileText: string | null };

/**
 * Enrich Artist nodes with realName and profile from the Discogs artist API.
 * Fetches GET /artists/{discogsId} for each Artist that still has neither realName nor
 * profile and whose last attempt has aged past the staleness window (see
 * getUnenrichedArtists). setArtistProfile stamps profileFetchedAt on every attempt so a
 * still-empty artist is retried at most once per window rather than every run.
 * Rate limiting is handled by DiscogsClient internally.
 * Per-artist errors are caught and counted — never crashes the caller.
 *
 * Note: Discogs does not expose a structured nationality or originCity field.
 * The profile property (free-text biography) is stored as-is for future use.
 */
export async function enrichArtistProfiles(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<ArtistProfilesEnrichmentSummary> {
  const log: Logger = logger ?? console;

  const stage: EnrichmentStage<UnenrichedArtist, ResolvedProfile> = {
    name: 'artist-profiles',
    selectCandidates: (d) => getUnenrichedArtists(d),
    async resolve(artist) {
      const profile = await client.getArtist(artist.discogsId);
      const realName = profile.realname?.trim() || null;
      const profileText = profile.profile?.trim() || null;
      return realName === null && profileText === null ? null : { realName, profileText };
    },
    write: (d, artist, resolved) =>
      setArtistProfile(d, artist.discogsId, resolved.realName, resolved.profileText),
    // Stamps profileFetchedAt with both fields null, throttling retries of still-empty artists.
    markAttempted: (d, artist) => setArtistProfile(d, artist.discogsId, null, null),
    describeItem: (artist) => `artist ${artist.discogsId}`,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
