import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';
import { mergeCountryClause } from './canonical-merges.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedMaster {
  masterDiscogsId: number;
  releaseIds: number[];
}

export interface CountryWithFormats {
  country: string;
  formats: string[];
}

// A Release is a candidate while it still lacks an originalYear (the master lookup either
// hasn't run or found no year), and only once its last attempt has aged past the staleness
// window (issue #89). Releases that already carry an originalYear are never re-fetched.
export async function getUnenrichedMasters(driver: Driver): Promise<UnenrichedMaster[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)
       WHERE r.masterDiscogsId IS NOT NULL
         AND r.originalYear IS NULL
         AND (r.masterFetchedAt IS NULL
              OR r.masterFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN r.masterDiscogsId AS masterDiscogsId, collect(r.discogsId) AS releaseIds`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
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

    if (countriesWithFormats.length > 0) {
      await session.run(
        `UNWIND $countriesWithFormats AS item
         MATCH (m:Master {discogsId: $masterDiscogsId})
         ${mergeCountryClause('item.country')}
         MERGE (m)-[rel:RELEASED_IN]->(c)
         SET rel.formats = item.formats`,
        {
          masterDiscogsId: neo4j.int(masterDiscogsId),
          countriesWithFormats,
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
       SET r.masterFetchedAt = datetime(), r.originalYear = $originalYear`,
      {
        releaseIds: releaseIds.map((id) => neo4j.int(id)),
        originalYear: neo4j.int(originalYear),
      },
    );
  } finally {
    await session.close();
  }
}

// Used when originalYear is unknown (year=0 on master): stamps the attempt timestamp
// without overwriting originalYear so coalesce(r.originalYear, r.pressingYear) still works.
// The release stays a candidate (originalYear still null) and is retried once per staleness
// window in case the master gains a year later.
export async function setMasterFetched(driver: Driver, releaseIds: number[]): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release) WHERE r.discogsId IN $releaseIds
       SET r.masterFetchedAt = datetime()`,
      { releaseIds: releaseIds.map((id) => neo4j.int(id)) },
    );
  } finally {
    await session.close();
  }
}
