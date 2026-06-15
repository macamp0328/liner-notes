import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/** An Artist or Musician node awaiting MusicBrainz-artist-MBID resolution (#380). */
export interface UnmappedPerson {
  discogsId: number;
  name: string;
}

/**
 * Return Artist nodes that still have no `musicbrainzId` and whose last attempt has aged past the
 * staleness window. Only nodes with a `discogsId` are candidates — the resolution is a Discogs-URL
 * lookup, so a Discogs ID is required. A node MusicBrainz has no Discogs link for is retried at
 * most once per window; `musicbrainzIdFetchedAt` throttles those retries (#89/#380).
 *
 * IDs 194 and 355 are Discogs "Various Artists" placeholder nodes — not real people — excluded as
 * elsewhere (artist-nationality / artist-profiles repositories).
 */
export async function getUnenrichedArtistsForMbid(driver: Driver): Promise<UnmappedPerson[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND a.musicbrainzId IS NULL
         AND NOT a.discogsId IN [194, 355]
         AND (a.musicbrainzIdFetchedAt IS NULL
              OR a.musicbrainzIdFetchedAt < datetime() - duration({ days: $stalenessDays }))
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
 * Return Musician nodes that still have no `musicbrainzId`, carry a `discogsId` (name-only `id===0`
 * credits can't be resolved via the Discogs-URL lookup, so they are excluded by design), and whose
 * last attempt has aged past the staleness window.
 */
export async function getUnenrichedMusiciansForMbid(driver: Driver): Promise<UnmappedPerson[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (m:Musician)
       WHERE m.discogsId IS NOT NULL
         AND m.musicbrainzId IS NULL
         AND (m.musicbrainzIdFetchedAt IS NULL
              OR m.musicbrainzIdFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN m.discogsId AS discogsId, m.name AS name`,
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
 * Store the resolved MusicBrainz artist MBID on an Artist node, stamping `musicbrainzIdFetchedAt`.
 * A null `mbid` (MusicBrainz had no Discogs link) stamps the marker only, so the node is retried at
 * most once per staleness window rather than every run.
 */
export async function setArtistMusicbrainzId(
  driver: Driver,
  discogsId: number,
  mbid: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    if (mbid !== null) {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         SET a.musicbrainzId = $mbid, a.musicbrainzIdFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId), mbid },
      );
    } else {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         SET a.musicbrainzIdFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId) },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Store the resolved MusicBrainz artist MBID on the Musician node(s) sharing this `discogsId`,
 * stamping `musicbrainzIdFetchedAt`. A null `mbid` stamps the marker only (throttled retry).
 */
export async function setMusicianMusicbrainzId(
  driver: Driver,
  discogsId: number,
  mbid: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    if (mbid !== null) {
      await session.run(
        `MATCH (m:Musician {discogsId: $discogsId})
         SET m.musicbrainzId = $mbid, m.musicbrainzIdFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId), mbid },
      );
    } else {
      await session.run(
        `MATCH (m:Musician {discogsId: $discogsId})
         SET m.musicbrainzIdFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId) },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Remove the `musicbrainzId` + `musicbrainzIdFetchedAt` markers from all Artist and Musician nodes
 * so the next mb-artist-id run re-resolves all of them. Backs `POST /admin/mb-artist-id/reset`.
 */
export async function resetMusicbrainzIdEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n) WHERE (n:Artist OR n:Musician)
         AND (n.musicbrainzId IS NOT NULL OR n.musicbrainzIdFetchedAt IS NOT NULL)
       REMOVE n.musicbrainzId, n.musicbrainzIdFetchedAt
       RETURN count(n) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | null)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
