import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedMaster {
  masterDiscogsId: number;
  releaseIds: number[];
}

export interface CountryWithFormats {
  country: string;
  formats: string[];
}

export async function getUnenrichedMasters(driver: Driver): Promise<UnenrichedMaster[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)
       WHERE r.masterDiscogsId IS NOT NULL AND r.masterFetched IS NULL
       RETURN r.masterDiscogsId AS masterDiscogsId, collect(r.discogsId) AS releaseIds`,
    );
    return result.records.map((r) => ({
      masterDiscogsId: (r.get('masterDiscogsId') as Neo4jInt).toNumber(),
      releaseIds: (r.get('releaseIds') as Neo4jInt[]).map((id) => id.toNumber()),
    }));
  } finally {
    await session.close();
  }
}

export async function mergeMasterData(
  driver: Driver,
  masterDiscogsId: number,
  title: string,
  year: number,
  countriesWithFormats: CountryWithFormats[],
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MERGE (m:Master {discogsId: $masterDiscogsId})
       SET m.title = $title, m.year = $year`,
      { masterDiscogsId: neo4j.int(masterDiscogsId), title, year: neo4j.int(year) },
    );

    for (const item of countriesWithFormats) {
      await session.run(
        `MATCH (m:Master {discogsId: $masterDiscogsId})
         MERGE (c:Country {name: $country})
         MERGE (m)-[rel:RELEASED_IN]->(c)
         SET rel.formats = $formats`,
        {
          masterDiscogsId: neo4j.int(masterDiscogsId),
          country: item.country,
          formats: item.formats,
        },
      );
    }
  } finally {
    await session.close();
  }
}

export async function setMasterFetchedAndOriginalYear(
  driver: Driver,
  releaseIds: number[],
  originalYear: number,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release) WHERE r.discogsId IN $releaseIds
       SET r.masterFetched = true, r.originalYear = $originalYear`,
      {
        releaseIds: releaseIds.map((id) => neo4j.int(id)),
        originalYear: neo4j.int(originalYear),
      },
    );
  } finally {
    await session.close();
  }
}
