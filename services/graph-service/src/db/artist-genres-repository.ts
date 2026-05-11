import type { Driver } from 'neo4j-driver';

/**
 * Roll up Genre names from every Release the Artist has released onto the
 * Artist node as a genres: String[] property.
 * Returns the number of Artist nodes updated.
 */
export async function aggregateArtistGenres(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)-[:IN_GENRE]->(g:Genre)
       WITH a, collect(DISTINCT g.name) AS genres
       SET a.genres = genres
       RETURN count(a) AS updated`,
    );
    const record = result.records[0];
    return record ? (record.get('updated') as number) : 0;
  } finally {
    await session.close();
  }
}

/**
 * Roll up Style names from every Release the Artist has released onto the
 * Artist node as a styles: String[] property.
 * Returns the number of Artist nodes updated.
 */
export async function aggregateArtistStyles(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)-[:IN_STYLE]->(s:Style)
       WITH a, collect(DISTINCT s.name) AS styles
       SET a.styles = styles
       RETURN count(a) AS updated`,
    );
    const record = result.records[0];
    return record ? (record.get('updated') as number) : 0;
  } finally {
    await session.close();
  }
}
