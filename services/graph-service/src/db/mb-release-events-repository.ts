import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { MbReleaseEvent } from '../ingestion/musicbrainz-client.js';
import { getStalenessDays } from '../enrichment/staleness.js';
import { normalizeCountry } from '../ingestion/transforms.js';
import { mergeCountryClause, mergeRegionClause } from './canonical-merges.js';

type Neo4jInt = { toNumber(): number };

// One MB release event resolved to its target place: an ISO `:Country` code or a `:Region` token
// (MB emits `XE`/`XW` for Europe/Worldwide). Carries the event's merge key + props (#441).
interface EventPlaceRow {
  mbReleaseId: string;
  code: string;
  date: string | null;
  formats: string[];
}

/**
 * Split MB release events into ISO `:Country` rows and `:Region` rows for the `MB_RELEASED_IN` /
 * `MB_RELEASED_IN_REGION` writes (#441). Pure + exported for unit testing. A single event's
 * `countryCode` resolves to at most one target (an ISO code never co-occurs with a region token), so
 * there is no per-event format collision (unlike the Discogs master-data path).
 */
export function splitReleaseEventsByPlace(events: MbReleaseEvent[]): {
  countryRows: EventPlaceRow[];
  regionRows: EventPlaceRow[];
} {
  const countryRows: EventPlaceRow[] = [];
  const regionRows: EventPlaceRow[] = [];
  for (const event of events) {
    if (event.countryCode === null) continue;
    const { countries, regions } = normalizeCountry(event.countryCode);
    const base = { mbReleaseId: event.mbReleaseId, date: event.date, formats: event.formats };
    for (const code of countries) countryRows.push({ ...base, code });
    for (const code of regions) regionRows.push({ ...base, code });
  }
  return { countryRows, regionRows };
}

// A Master is a candidate while it has no MB_RELEASED_IN relationship (the MusicBrainz
// lookup either hasn't run or found no events) and its last attempt has aged past the
// staleness window (issue #89). A Master that already has events is never re-fetched.
export async function getMastersForReleaseEventEnrichment(
  driver: Driver,
): Promise<{ masterDiscogsId: number }[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Master)
       WHERE NOT EXISTS { (m)-[:MB_RELEASED_IN]->() }
         AND NOT EXISTS { (m)-[:MB_RELEASED_IN_REGION]->() }
         AND (m.mbReleaseEventsFetchedAt IS NULL
              OR m.mbReleaseEventsFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN m.discogsId AS masterDiscogsId`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((r) => ({
      masterDiscogsId: (r.get('masterDiscogsId') as Neo4jInt).toNumber(),
    }));
  } finally {
    await session.close();
  }
}

export async function mergeMbReleaseEvents(
  driver: Driver,
  masterDiscogsId: number,
  events: MbReleaseEvent[],
): Promise<void> {
  const { countryRows, regionRows } = splitReleaseEventsByPlace(events);
  if (countryRows.length === 0 && regionRows.length === 0) return;

  const session = driver.session();
  try {
    if (countryRows.length > 0) {
      await session.run(
        `UNWIND $events AS event
         MATCH (m:Master {discogsId: $masterDiscogsId})
         ${mergeCountryClause('event.code')}
         MERGE (m)-[r:MB_RELEASED_IN {mbReleaseId: event.mbReleaseId}]->(c)
         SET r.date = event.date, r.formats = event.formats, r.source = 'musicbrainz'`,
        { masterDiscogsId: neo4j.int(masterDiscogsId), events: countryRows },
      );
    }
    if (regionRows.length > 0) {
      await session.run(
        `UNWIND $events AS event
         MATCH (m:Master {discogsId: $masterDiscogsId})
         ${mergeRegionClause('event.code')}
         MERGE (m)-[r:MB_RELEASED_IN_REGION {mbReleaseId: event.mbReleaseId}]->(g)
         SET r.date = event.date, r.formats = event.formats, r.source = 'musicbrainz'`,
        { masterDiscogsId: neo4j.int(masterDiscogsId), events: regionRows },
      );
    }
  } finally {
    await session.close();
  }
}

export async function setMbReleaseEventsFetched(
  driver: Driver,
  masterDiscogsId: number,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (m:Master {discogsId: $masterDiscogsId}) SET m.mbReleaseEventsFetchedAt = datetime()`,
      { masterDiscogsId: neo4j.int(masterDiscogsId) },
    );
  } finally {
    await session.close();
  }
}

export async function resetMbReleaseEventsEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const resetResult = await session.run(
      `MATCH (m:Master) WHERE m.mbReleaseEventsFetchedAt IS NOT NULL
       REMOVE m.mbReleaseEventsFetchedAt
       RETURN count(m) AS reset`,
    );
    const reset = (resetResult.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;

    await session.run(`MATCH ()-[r:MB_RELEASED_IN|MB_RELEASED_IN_REGION]->() DELETE r`);

    return reset;
  } finally {
    await session.close();
  }
}
