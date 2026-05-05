import { Driver } from 'neo4j-driver';

// Neo4j 5.x syntax — IF NOT EXISTS makes every statement idempotent
const statements = [
  'CREATE CONSTRAINT release_discogs_id IF NOT EXISTS FOR (r:Release) REQUIRE r.discogsId IS UNIQUE',
  'CREATE CONSTRAINT artist_discogs_id IF NOT EXISTS FOR (a:Artist) REQUIRE a.discogsId IS UNIQUE',
  'CREATE CONSTRAINT label_discogs_id IF NOT EXISTS FOR (l:Label) REQUIRE l.discogsId IS UNIQUE',
  'CREATE CONSTRAINT genre_name IF NOT EXISTS FOR (g:Genre) REQUIRE g.name IS UNIQUE',
  'CREATE CONSTRAINT style_name IF NOT EXISTS FOR (s:Style) REQUIRE s.name IS UNIQUE',
  'CREATE CONSTRAINT country_name IF NOT EXISTS FOR (c:Country) REQUIRE c.name IS UNIQUE',
  'CREATE CONSTRAINT decade_name IF NOT EXISTS FOR (d:Decade) REQUIRE d.name IS UNIQUE',
  'CREATE FULLTEXT INDEX trackLyrics IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics, t.title]',
  'CREATE INDEX release_year IF NOT EXISTS FOR (r:Release) ON (r.year)',
  'CREATE INDEX musician_name IF NOT EXISTS FOR (m:Musician) ON (m.name)',
  'CREATE INDEX studio_name IF NOT EXISTS FOR (s:Studio) ON (s.name)',
];

export async function applySchema(driver: Driver): Promise<void> {
  for (const statement of statements) {
    const session = driver.session();
    try {
      await session.run(statement);
    } catch (err) {
      // Log but don't crash — a missing optional plugin won't block startup
      console.warn(`Schema statement skipped: ${(err as Error).message}`);
    } finally {
      await session.close();
    }
  }
}
