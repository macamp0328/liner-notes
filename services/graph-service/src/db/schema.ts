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
  'CREATE INDEX studio_name IF NOT EXISTS FOR (s:Studio) ON (s.name)',
  'CREATE INDEX track_normalized_title IF NOT EXISTS FOR (t:Track) ON (t.normalizedTitle)',
  'CREATE FULLTEXT INDEX releaseArtistTrackSearch IF NOT EXISTS FOR (n:Release|Artist|Track) ON EACH [n.title, n.name]',
  'CREATE FULLTEXT INDEX lyricsSearch IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics]',
  'CREATE INDEX artist_nationality_fetched IF NOT EXISTS FOR (a:Artist) ON (a.nationalityFetched)',
  'CREATE INDEX musician_nationality_fetched IF NOT EXISTS FOR (m:Musician) ON (m.nationalityFetched)',
  'CREATE CONSTRAINT master_discogs_id IF NOT EXISTS FOR (m:Master) REQUIRE m.discogsId IS UNIQUE',
  'CREATE INDEX release_master_fetched IF NOT EXISTS FOR (r:Release) ON (r.masterFetched)',
  'CREATE INDEX master_mb_release_events_fetched IF NOT EXISTS FOR (m:Master) ON (m.mbReleaseEventsFetched)',
  'CREATE INDEX track_recording_mbid IF NOT EXISTS FOR (t:Track) ON (t.recordingMbid)',
  'CREATE INDEX track_isrc IF NOT EXISTS FOR (t:Track) ON (t.isrc)',
  'CREATE INDEX track_musicbrainz_fetched IF NOT EXISTS FOR (t:Track) ON (t.musicBrainzFetched)',
  'CREATE INDEX track_acousticbrainz_fetched IF NOT EXISTS FOR (t:Track) ON (t.acousticBrainzFetched)',
  'CREATE INDEX track_tempo IF NOT EXISTS FOR (t:Track) ON (t.tempo)',
  'CREATE INDEX track_musical_scale IF NOT EXISTS FOR (t:Track) ON (t.musicalScale)',
  'CREATE INDEX track_deezer_fetched IF NOT EXISTS FOR (t:Track) ON (t.deezerFetched)',
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
