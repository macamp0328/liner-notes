import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type { MbReleaseEvent } from '../ingestion/musicbrainz-client.js';

type Neo4jInt = { toNumber(): number };

export async function getMastersForReleaseEventEnrichment(
  driver: Driver,
): Promise<{ masterDiscogsId: number }[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Master) WHERE m.mbReleaseEventsFetched IS NULL RETURN m.discogsId AS masterDiscogsId`,
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
  const withCountry = events.filter((e) => e.countryCode !== null);
  if (withCountry.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $events AS event
       MATCH (m:Master {discogsId: $masterDiscogsId})
       MERGE (c:Country {name: event.countryCode})
       MERGE (m)-[r:MB_RELEASED_IN {mbReleaseId: event.mbReleaseId}]->(c)
       SET r.date = event.date, r.formats = event.formats`,
      {
        masterDiscogsId: neo4j.int(masterDiscogsId),
        events: withCountry.map((e) => ({
          mbReleaseId: e.mbReleaseId,
          countryCode: e.countryCode,
          date: e.date,
          formats: e.formats,
        })),
      },
    );
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
      `MATCH (m:Master {discogsId: $masterDiscogsId}) SET m.mbReleaseEventsFetched = true`,
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
      `MATCH (m:Master) WHERE m.mbReleaseEventsFetched IS NOT NULL
       REMOVE m.mbReleaseEventsFetched
       RETURN count(m) AS reset`,
    );
    const reset = (resetResult.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;

    await session.run(`MATCH ()-[r:MB_RELEASED_IN]->() DELETE r`);

    return reset;
  } finally {
    await session.close();
  }
}
