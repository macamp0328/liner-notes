import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/**
 * Which upstream source resolved an ORIGIN_COUNTRY relationship. Stored as a
 * `source` property on the relationship so /api/v1/stats can split nationality
 * coverage per source. Edges written before this property existed carry no
 * source — surfaced as an `untagged` bucket in the stats split until the next
 * full re-run tags them.
 */
export type NationalitySource = 'musicbrainz' | 'wikidata';

export interface UnenrichedArtist {
  discogsId: number;
  name: string;
  /** MB artist MBID resolved by the mb-artist-id pass (#380); null when unresolved. */
  musicbrainzId: string | null;
}

export interface UnenrichedMusician {
  discogsId: number | null;
  name: string;
  /** MB artist MBID resolved by the mb-artist-id pass (#380); null when unresolved. */
  musicbrainzId: string | null;
}

/**
 * Return Artist nodes that still have no ORIGIN_COUNTRY relationship (never attempted, or
 * attempted but no country was found) and whose last attempt has aged past the staleness
 * window (issue #89). An artist that already has a country is never re-fetched; one no
 * source could resolve is retried at most once per window. `nationalityFetchedAt` throttles
 * those retries (the ORIGIN_COUNTRY absence alone would re-attempt every run).
 */
export async function getUnenrichedArtistsForNationality(
  driver: Driver,
): Promise<UnenrichedArtist[]> {
  const session = driver.session();
  try {
    // IDs 194 and 355 are Discogs "Various Artists" placeholder nodes — not real people.
    // Same exclusion applied in getUnenrichedArtists() in artist-profiles-repository.ts.
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND NOT EXISTS { (a)-[:ORIGIN_COUNTRY]->() }
         AND NOT a.discogsId IN [194, 355]
         AND (a.nationalityFetchedAt IS NULL
              OR a.nationalityFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN a.discogsId AS discogsId, a.name AS name, a.musicbrainzId AS musicbrainzId`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt).toNumber(),
      name: r.get('name') as string,
      musicbrainzId: (r.get('musicbrainzId') as string | null) ?? null,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Return Musician nodes that have not yet been enriched with nationality data.
 * Returns both discogsId (when available) and name for lookup purposes.
 */
export async function getUnenrichedMusiciansForNationality(
  driver: Driver,
): Promise<UnenrichedMusician[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Musician)
       WHERE NOT EXISTS { (m)-[:ORIGIN_COUNTRY]->() }
         AND (m.nationalityFetchedAt IS NULL
              OR m.nationalityFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN m.discogsId AS discogsId, m.name AS name, m.musicbrainzId AS musicbrainzId`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt | null)?.toNumber() ?? null,
      name: r.get('name') as string,
      musicbrainzId: (r.get('musicbrainzId') as string | null) ?? null,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Set the ORIGIN_COUNTRY relationship on an Artist node identified by discogsId.
 * When countryCode is non-null, merges a Country node and creates the relationship,
 * tagging it with the `source` that resolved the country (musicbrainz/wikidata).
 * Always stamps nationalityFetchedAt = datetime() regardless of whether a country was
 * found — the timestamp throttles re-attempts of still-uncountried nodes to once per
 * staleness window (issue #89).
 *
 * Deletes any existing ORIGIN_COUNTRY relationship before creating the new one so that
 * re-runs with updated source data (e.g. after adding Wikidata) replace stale values
 * rather than accumulating duplicates.
 */
export async function setArtistNationality(
  driver: Driver,
  discogsId: number,
  countryCode: string | null,
  source: NationalitySource | null,
): Promise<void> {
  const session = driver.session();
  try {
    if (countryCode !== null) {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         OPTIONAL MATCH (a)-[old:ORIGIN_COUNTRY]->()
         DELETE old
         WITH a
         MERGE (c:Country {name: $countryCode})
         MERGE (a)-[rel:ORIGIN_COUNTRY]->(c)
         SET rel.source = $source, a.nationalityFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId), countryCode, source },
      );
    } else {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         SET a.nationalityFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId) },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Set the ORIGIN_COUNTRY relationship on a Musician node.
 * Identifies by discogsId when available; falls back to name-only match.
 * Always stamps nationalityFetchedAt = datetime() (throttles retries of still-uncountried nodes).
 *
 * Deletes any existing ORIGIN_COUNTRY relationship before creating the new one
 * so that re-runs replace stale values rather than accumulating duplicates.
 */
export async function setMusicianNationality(
  driver: Driver,
  musician: Pick<UnenrichedMusician, 'discogsId' | 'name'>,
  countryCode: string | null,
  source: NationalitySource | null,
): Promise<void> {
  const session = driver.session();
  try {
    const matchClause =
      musician.discogsId !== null
        ? `MATCH (m:Musician {discogsId: $discogsId})`
        : `MATCH (m:Musician {name: $name}) WHERE m.discogsId IS NULL`;

    if (countryCode !== null) {
      await session.run(
        `${matchClause}
         OPTIONAL MATCH (m)-[old:ORIGIN_COUNTRY]->()
         DELETE old
         WITH m
         MERGE (c:Country {name: $countryCode})
         MERGE (m)-[rel:ORIGIN_COUNTRY]->(c)
         SET rel.source = $source, m.nationalityFetchedAt = datetime()`,
        {
          discogsId: musician.discogsId !== null ? neo4j.int(musician.discogsId) : null,
          name: musician.name,
          countryCode,
          source,
        },
      );
    } else {
      await session.run(
        `${matchClause}
         SET m.nationalityFetchedAt = datetime()`,
        {
          discogsId: musician.discogsId !== null ? neo4j.int(musician.discogsId) : null,
          name: musician.name,
        },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Remove the nationalityFetchedAt marker from all Artist and Musician nodes so the
 * next enrichment run re-processes all of them.
 */
export async function resetNationalityEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n) WHERE (n:Artist OR n:Musician) AND n.nationalityFetchedAt IS NOT NULL
       REMOVE n.nationalityFetchedAt
       RETURN count(n) AS reset`,
    );
    return (result.records[0]?.get('reset') as { toNumber(): number } | null)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
