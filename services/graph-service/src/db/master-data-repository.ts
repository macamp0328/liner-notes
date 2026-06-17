import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';
import { normalizeCountry } from '../ingestion/transforms.js';
import { mergeCountryClause, mergeRegionClause } from './canonical-merges.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedMaster {
  masterDiscogsId: number;
  releaseIds: number[];
}

export interface CountryWithFormats {
  country: string;
  formats: string[];
}

// A normalized pressing-place row: an ISO `:Country` code or a `:Region` token, with the union of all
// formats seen for raw strings that collapse onto it.
export interface PlaceWithFormats {
  code: string;
  formats: string[];
}

/**
 * Normalize raw Discogs pressing countries (#441) into ISO `:Country` rows + `:Region` rows for the
 * `RELEASED_IN` / `RELEASED_IN_REGION` writes. Pure + exported for unit testing.
 *
 * Distinct raw strings can collapse onto one code (`UK` + `England` → `GB`; `UK & Europe` + `Europe`
 * → region `EU`). Because `RELEASED_IN` has no merge key beyond the (Master, place) endpoints, the
 * later write would otherwise clobber `formats`; we **union** formats per code here so the surviving
 * edge carries every format. (Done in TS, not `ON CREATE SET`, which would freeze the first batch's
 * formats across reload runs.)
 */
export function buildReleasedInRows(countriesWithFormats: CountryWithFormats[]): {
  countryRows: PlaceWithFormats[];
  regionRows: PlaceWithFormats[];
} {
  const byCountry = new Map<string, Set<string>>();
  const byRegion = new Map<string, Set<string>>();
  const union = (acc: Map<string, Set<string>>, code: string, formats: string[]): void => {
    const set = acc.get(code) ?? new Set<string>();
    for (const f of formats) set.add(f);
    acc.set(code, set);
  };
  for (const item of countriesWithFormats) {
    const { countries, regions } = normalizeCountry(item.country);
    for (const code of countries) union(byCountry, code, item.formats);
    for (const code of regions) union(byRegion, code, item.formats);
  }
  const toRows = (acc: Map<string, Set<string>>): PlaceWithFormats[] =>
    [...acc].map(([code, formats]) => ({ code, formats: [...formats] }));
  return { countryRows: toRows(byCountry), regionRows: toRows(byRegion) };
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

    const { countryRows, regionRows } = buildReleasedInRows(countriesWithFormats);
    if (countryRows.length > 0) {
      await session.run(
        `UNWIND $rows AS row
         MATCH (m:Master {discogsId: $masterDiscogsId})
         ${mergeCountryClause('row.code')}
         MERGE (m)-[rel:RELEASED_IN]->(c)
         SET rel.formats = row.formats`,
        { masterDiscogsId: neo4j.int(masterDiscogsId), rows: countryRows },
      );
    }
    if (regionRows.length > 0) {
      await session.run(
        `UNWIND $rows AS row
         MATCH (m:Master {discogsId: $masterDiscogsId})
         ${mergeRegionClause('row.code')}
         MERGE (m)-[rel:RELEASED_IN_REGION]->(g)
         SET rel.formats = row.formats`,
        { masterDiscogsId: neo4j.int(masterDiscogsId), rows: regionRows },
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
