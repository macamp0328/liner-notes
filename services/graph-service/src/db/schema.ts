import { Driver } from 'neo4j-driver';

// Neo4j 5.x syntax — IF NOT EXISTS makes every statement idempotent
const statements = [
  'CREATE CONSTRAINT release_discogs_id IF NOT EXISTS FOR (r:Release) REQUIRE r.discogsId IS UNIQUE',
  'CREATE CONSTRAINT artist_discogs_id IF NOT EXISTS FOR (a:Artist) REQUIRE a.discogsId IS UNIQUE',
  'CREATE CONSTRAINT label_discogs_id IF NOT EXISTS FOR (l:Label) REQUIRE l.discogsId IS UNIQUE',
  'CREATE CONSTRAINT genre_name IF NOT EXISTS FOR (g:Genre) REQUIRE g.name IS UNIQUE',
  'CREATE CONSTRAINT style_name IF NOT EXISTS FOR (s:Style) REQUIRE s.name IS UNIQUE',
  'CREATE CONSTRAINT country_name IF NOT EXISTS FOR (c:Country) REQUIRE c.name IS UNIQUE',
  'CREATE FULLTEXT INDEX trackLyrics IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics, t.title]',
  'CREATE INDEX release_pressing_year IF NOT EXISTS FOR (r:Release) ON (r.pressingYear)',
  // One-time migration: copy r.year → r.pressingYear for existing nodes created before the rename.
  // Safe to re-run: the WHERE guard makes it a no-op once all nodes are migrated.
  'MATCH (r:Release) WHERE r.year IS NOT NULL AND r.pressingYear IS NULL SET r.pressingYear = r.year',
  'CREATE INDEX musician_name IF NOT EXISTS FOR (m:Musician) ON (m.name)',
  // issue #330: backs the (:Musician {discogsId}) point lookups in setGroupMembers (group + each
  // member). The reconciliation/stats queries full-scan Musician regardless, so this is for the
  // group-members write path, not those.
  'CREATE INDEX musician_discogs_id IF NOT EXISTS FOR (m:Musician) ON (m.discogsId)',
  // issue #330: backs the staleness-gated group-members candidate scan (getGroupCandidates).
  'CREATE INDEX musician_members_fetched_at IF NOT EXISTS FOR (m:Musician) ON (m.membersFetchedAt)',
  'CREATE INDEX studio_name IF NOT EXISTS FOR (s:Studio) ON (s.name)',
  // issue #196: the track-versions stage (sole reader of t.normalizedTitle) was dropped.
  // Drop its now-unused index; IF EXISTS keeps this a no-op once cleared.
  'DROP INDEX track_normalized_title IF EXISTS',
  'CREATE FULLTEXT INDEX releaseArtistTrackSearch IF NOT EXISTS FOR (n:Release|Artist|Track) ON EACH [n.title, n.name]',
  'CREATE FULLTEXT INDEX lyricsSearch IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics]',
  'CREATE CONSTRAINT master_discogs_id IF NOT EXISTS FOR (m:Master) REQUIRE m.discogsId IS UNIQUE',
  'CREATE INDEX track_recording_mbid IF NOT EXISTS FOR (t:Track) ON (t.recordingMbid)',
  'CREATE INDEX track_isrc IF NOT EXISTS FOR (t:Track) ON (t.isrc)',
  'CREATE INDEX track_tempo IF NOT EXISTS FOR (t:Track) ON (t.tempo)',
  'CREATE INDEX track_musical_scale IF NOT EXISTS FOR (t:Track) ON (t.musicalScale)',

  // --- issue #89: enrichment idempotency markers are now `*FetchedAt` timestamps ---
  // Drop the old boolean-marker indexes (their property no longer exists) and create
  // range indexes on the new datetime markers. Old DROPs use distinct names from the new
  // CREATEs so neither statement churns on subsequent startups (DROP IF EXISTS → no-op,
  // CREATE IF NOT EXISTS → no-op).
  'DROP INDEX artist_nationality_fetched IF EXISTS',
  'DROP INDEX musician_nationality_fetched IF EXISTS',
  'DROP INDEX release_master_fetched IF EXISTS',
  'DROP INDEX master_mb_release_events_fetched IF EXISTS',
  'DROP INDEX track_musicbrainz_fetched IF EXISTS',
  'DROP INDEX track_acousticbrainz_fetched IF EXISTS',
  'DROP INDEX track_deezer_fetched IF EXISTS',
  'CREATE INDEX artist_nationality_fetched_at IF NOT EXISTS FOR (a:Artist) ON (a.nationalityFetchedAt)',
  'CREATE INDEX musician_nationality_fetched_at IF NOT EXISTS FOR (m:Musician) ON (m.nationalityFetchedAt)',
  'CREATE INDEX release_master_fetched_at IF NOT EXISTS FOR (r:Release) ON (r.masterFetchedAt)',
  'CREATE INDEX master_mb_release_events_fetched_at IF NOT EXISTS FOR (m:Master) ON (m.mbReleaseEventsFetchedAt)',
  'CREATE INDEX track_musicbrainz_fetched_at IF NOT EXISTS FOR (t:Track) ON (t.musicBrainzFetchedAt)',
  'CREATE INDEX track_acousticbrainz_fetched_at IF NOT EXISTS FOR (t:Track) ON (t.acousticBrainzFetchedAt)',
  'CREATE INDEX track_deezer_fetched_at IF NOT EXISTS FOR (t:Track) ON (t.deezerFetchedAt)',
  'CREATE INDEX track_lyrics_fetched_at IF NOT EXISTS FOR (t:Track) ON (t.lyricsFetchedAt)',

  // One-time cleanup: remove the superseded boolean markers. The `*FetchedAt` queries
  // never read them, so this is cosmetic — but it keeps the graph free of vestigial
  // properties. Idempotent: the WHERE guards make each a no-op once cleared.
  'MATCH (n) WHERE (n:Artist OR n:Musician) AND n.nationalityFetched IS NOT NULL REMOVE n.nationalityFetched',
  'MATCH (a:Artist) WHERE a.profileFetched IS NOT NULL REMOVE a.profileFetched',
  'MATCH (r:Release) WHERE r.masterFetched IS NOT NULL REMOVE r.masterFetched',
  'MATCH (m:Master) WHERE m.mbReleaseEventsFetched IS NOT NULL REMOVE m.mbReleaseEventsFetched',
  'MATCH (t:Track) WHERE t.musicBrainzFetched IS NOT NULL OR t.acousticBrainzFetched IS NOT NULL OR t.deezerFetched IS NOT NULL REMOVE t.musicBrainzFetched, t.acousticBrainzFetched, t.deezerFetched',

  // --- issue #196: the track-versions stage was dropped ---
  // Remove its vestigial graph data so the drop leaves the DB clean, not just the code.
  // Both are idempotent: the relationship match finds nothing once deleted, and the WHERE
  // guard makes the property removal a no-op once cleared. (The unused index is dropped above.)
  'MATCH ()-[r:IS_VERSION_OF]->() DELETE r',
  'MATCH (t:Track) WHERE t.normalizedTitle IS NOT NULL REMOVE t.normalizedTitle',

  // --- issue #246: four-state lyricsStatus ---
  // Backfill the new lyricsStatus on tracks that already have lyrics from before the field
  // existed, so the candidate query and the /stats funnel see a consistent data model.
  // Idempotent: the WHERE guard makes it a no-op once every lyric'd track is tagged.
  "MATCH (t:Track) WHERE t.lyrics IS NOT NULL AND t.lyricsStatus IS NULL SET t.lyricsStatus = 'resolved'",

  // --- issue #175: persistent orchestrated-reload job state ---
  // A ReloadJob (one per run) owns a set of ReloadStage checkpoint nodes so an
  // interrupted reload resumes from the last completed stage after a pod restart.
  // createReloadJob writes exactly one ReloadStage per stage name per job (transitions
  // are MATCH+SET), so there is no ReloadStage uniqueness constraint — the plain jobId
  // index keeps per-job lookups fast and avoids an enterprise-only composite constraint.
  'CREATE CONSTRAINT reload_job_id IF NOT EXISTS FOR (j:ReloadJob) REQUIRE j.jobId IS UNIQUE',
  'CREATE INDEX reload_stage_job IF NOT EXISTS FOR (s:ReloadStage) ON (s.jobId)',
  'CREATE INDEX reload_job_started_at IF NOT EXISTS FOR (j:ReloadJob) ON (j.startedAt)',
];

export async function applySchema(driver: Driver): Promise<void> {
  for (const statement of statements) {
    const session = driver.session();
    try {
      await session.run(statement);
    } finally {
      await session.close();
    }
  }
}
