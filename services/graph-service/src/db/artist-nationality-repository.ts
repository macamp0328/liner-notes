import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedArtist {
  discogsId: number;
}

export interface UnenrichedMusician {
  discogsId: number | null;
  name: string;
}

/**
 * Return Artist nodes that have not yet been enriched with nationality data.
 * Uses nationalityFetched as an explicit idempotency marker — Neo4j removes null
 * properties on SET, so checking nationalityFetched IS NULL reliably distinguishes
 * "never attempted" from "attempted but country was not found".
 */
export async function getUnenrichedArtistsForNationality(
  driver: Driver,
): Promise<UnenrichedArtist[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND a.nationalityFetched IS NULL
         AND NOT a.discogsId IN [194, 355]
       RETURN a.discogsId AS discogsId`,
    );
    return result.records.map((r) => ({
      discogsId: (r.get('discogsId') as Neo4jInt).toNumber(),
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
       WHERE m.nationalityFetched IS NULL
       RETURN m.discogsId AS discogsId, m.name AS name`,
    );
    return result.records.map((r) => {
      const rawId = r.get('discogsId');
      return {
        discogsId: rawId !== null ? (rawId as Neo4jInt).toNumber() : null,
        name: r.get('name') as string,
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Set the ORIGIN_COUNTRY relationship on an Artist node identified by discogsId.
 * When countryCode is non-null, merges a Country node and creates the relationship.
 * Always sets nationalityFetched = true as an idempotency marker regardless of
 * whether a country was found — same pattern as profileFetched on artist profiles.
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
         MERGE (c:Country {name: $countryCode})
         MERGE (a)-[:ORIGIN_COUNTRY]->(c)
         SET a.nationalityFetched = true`,
        { discogsId: neo4j.int(discogsId), countryCode },
      );
    } else {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         SET a.nationalityFetched = true`,
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
 * Always sets nationalityFetched = true.
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
         MERGE (c:Country {name: $countryCode})
         MERGE (m)-[:ORIGIN_COUNTRY]->(c)
         SET m.nationalityFetched = true`,
        {
          discogsId: musician.discogsId !== null ? neo4j.int(musician.discogsId) : null,
          name: musician.name,
          countryCode,
        },
      );
    } else {
      await session.run(
        `${matchClause}
         SET m.nationalityFetched = true`,
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
