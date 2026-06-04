import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedArtist {
  discogsId: number;
  name: string;
}

export interface UnenrichedMusician {
  discogsId: number | null;
  name: string;
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
       RETURN a.discogsId AS discogsId, a.name AS name`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt).toNumber(),
      name: r.get('name') as string,
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
       RETURN m.discogsId AS discogsId, m.name AS name`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt | null)?.toNumber() ?? null,
      name: r.get('name') as string,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Return Producer nodes that have not yet been enriched with nationality data.
 */
export async function getUnenrichedProducersForNationality(
  driver: Driver,
): Promise<UnenrichedMusician[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Producer)
       WHERE NOT EXISTS { (m)-[:ORIGIN_COUNTRY]->() }
         AND (m.nationalityFetchedAt IS NULL
              OR m.nationalityFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN m.discogsId AS discogsId, m.name AS name`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt | null)?.toNumber() ?? null,
      name: r.get('name') as string,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Return Engineer nodes that have not yet been enriched with nationality data.
 */
export async function getUnenrichedEngineersForNationality(
  driver: Driver,
): Promise<UnenrichedMusician[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Engineer)
       WHERE NOT EXISTS { (m)-[:ORIGIN_COUNTRY]->() }
         AND (m.nationalityFetchedAt IS NULL
              OR m.nationalityFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN m.discogsId AS discogsId, m.name AS name`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt | null)?.toNumber() ?? null,
      name: r.get('name') as string,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Set the ORIGIN_COUNTRY relationship on an Artist node identified by discogsId.
 * When countryCode is non-null, merges a Country node and creates the relationship.
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
         MERGE (a)-[:ORIGIN_COUNTRY]->(c)
         SET a.nationalityFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId), countryCode },
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
  musician: UnenrichedMusician,
  countryCode: string | null,
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
         MERGE (m)-[:ORIGIN_COUNTRY]->(c)
         SET m.nationalityFetchedAt = datetime()`,
        {
          discogsId: musician.discogsId !== null ? neo4j.int(musician.discogsId) : null,
          name: musician.name,
          countryCode,
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
 * Set the ORIGIN_COUNTRY relationship on a Producer node.
 * Identifies by discogsId when available; falls back to name-only match.
 * Always stamps nationalityFetchedAt = datetime() (throttles retries of still-uncountried nodes).
 */
export async function setProducerNationality(
  driver: Driver,
  producer: UnenrichedMusician,
  countryCode: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    const matchClause =
      producer.discogsId !== null
        ? `MATCH (m:Producer {discogsId: $discogsId})`
        : `MATCH (m:Producer {name: $name}) WHERE m.discogsId IS NULL`;

    if (countryCode !== null) {
      await session.run(
        `${matchClause}
         OPTIONAL MATCH (m)-[old:ORIGIN_COUNTRY]->()
         DELETE old
         WITH m
         MERGE (c:Country {name: $countryCode})
         MERGE (m)-[:ORIGIN_COUNTRY]->(c)
         SET m.nationalityFetchedAt = datetime()`,
        {
          discogsId: producer.discogsId !== null ? neo4j.int(producer.discogsId) : null,
          name: producer.name,
          countryCode,
        },
      );
    } else {
      await session.run(
        `${matchClause}
         SET m.nationalityFetchedAt = datetime()`,
        {
          discogsId: producer.discogsId !== null ? neo4j.int(producer.discogsId) : null,
          name: producer.name,
        },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Set the ORIGIN_COUNTRY relationship on an Engineer node.
 * Identifies by discogsId when available; falls back to name-only match.
 * Always stamps nationalityFetchedAt = datetime() (throttles retries of still-uncountried nodes).
 */
export async function setEngineerNationality(
  driver: Driver,
  engineer: UnenrichedMusician,
  countryCode: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    const matchClause =
      engineer.discogsId !== null
        ? `MATCH (m:Engineer {discogsId: $discogsId})`
        : `MATCH (m:Engineer {name: $name}) WHERE m.discogsId IS NULL`;

    if (countryCode !== null) {
      await session.run(
        `${matchClause}
         OPTIONAL MATCH (m)-[old:ORIGIN_COUNTRY]->()
         DELETE old
         WITH m
         MERGE (c:Country {name: $countryCode})
         MERGE (m)-[:ORIGIN_COUNTRY]->(c)
         SET m.nationalityFetchedAt = datetime()`,
        {
          discogsId: engineer.discogsId !== null ? neo4j.int(engineer.discogsId) : null,
          name: engineer.name,
          countryCode,
        },
      );
    } else {
      await session.run(
        `${matchClause}
         SET m.nationalityFetchedAt = datetime()`,
        {
          discogsId: engineer.discogsId !== null ? neo4j.int(engineer.discogsId) : null,
          name: engineer.name,
        },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Remove the nationalityFetchedAt marker from all Artist, Musician, Producer, and Engineer
 * nodes so the next enrichment run re-processes all of them.
 */
export async function resetNationalityEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n) WHERE (n:Artist OR n:Musician OR n:Producer OR n:Engineer) AND n.nationalityFetchedAt IS NOT NULL
       REMOVE n.nationalityFetchedAt
       RETURN count(n) AS reset`,
    );
    return (result.records[0]?.get('reset') as { toNumber(): number } | null)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
