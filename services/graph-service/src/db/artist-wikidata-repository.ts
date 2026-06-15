import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';
import type { ArtistWikidataData } from '../ingestion/wikidata-client.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedArtist {
  discogsId: number;
  name: string;
}

/**
 * Return Artist nodes whose Wikidata identity hasn't been resolved yet (#341) — `wikidataQid IS
 * NULL` (never resolved, or attempted but the artist isn't in Wikidata) and whose last attempt has
 * aged past the staleness window (issue #89). An artist whose QID is resolved is never re-fetched
 * automatically (run `/reset` to refresh, exactly like nationality's ORIGIN_COUNTRY gate); one
 * Wikidata doesn't (yet) know is retried at most once per window. `wikidataFetchedAt` throttles
 * those retries — the `wikidataQid IS NULL` gate alone would re-attempt every run.
 */
export async function getUnenrichedArtistsForWikidata(driver: Driver): Promise<UnenrichedArtist[]> {
  const session = driver.session();
  try {
    // IDs 194 and 355 are Discogs "Various Artists" placeholder nodes — not real people.
    // Same exclusion applied across the other Artist enrichments.
    const result = await session.run(
      `MATCH (a:Artist)
       WHERE a.discogsId IS NOT NULL
         AND a.wikidataQid IS NULL
         AND NOT a.discogsId IN [194, 355]
         AND (a.wikidataFetchedAt IS NULL
              OR a.wikidataFetchedAt < datetime() - duration({ days: $stalenessDays }))
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
 * Persist an Artist's resolved Wikidata bundle, or (when `data` is null) just stamp the attempt.
 * Always sets `wikidataFetchedAt = datetime()` — the timestamp throttles re-attempts of artists
 * Wikidata doesn't know to once per staleness window (issue #89).
 *
 * On a successful resolve every field is overwritten with Wikidata's current truth, including
 * `SET prop = null` for an absent field (Neo4j removes the property) — so a re-run replaces stale
 * values rather than accumulating them. `awards`, `playsInstrument`, `playsInstrumentRaw`, and
 * `influencedByQids` are each stored as a list (possibly empty), never null. `influencedByQids` (P737,
 * #391) is the raw target-QID list the `artist-influences` pass later resolves into `INFLUENCED_BY`
 * edges.
 */
export async function setArtistWikidata(
  driver: Driver,
  discogsId: number,
  data: ArtistWikidataData | null,
): Promise<void> {
  const session = driver.session();
  try {
    if (data !== null) {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         SET a.wikidataQid = $qid,
             a.bornYear = $bornYear,
             a.bornDate = $bornDate,
             a.diedYear = $diedYear,
             a.diedDate = $diedDate,
             a.imageUrl = $imageUrl,
             a.awards = $awards,
             a.playsInstrument = $playsInstrument,
             a.playsInstrumentRaw = $playsInstrumentRaw,
             a.influencedByQids = $influencedByQids,
             a.wikidataFetchedAt = datetime()`,
        {
          discogsId: neo4j.int(discogsId),
          qid: data.qid,
          bornYear: data.bornYear !== null ? neo4j.int(data.bornYear) : null,
          bornDate: data.bornDate,
          diedYear: data.diedYear !== null ? neo4j.int(data.diedYear) : null,
          diedDate: data.diedDate,
          imageUrl: data.imageUrl,
          awards: data.awards,
          playsInstrument: data.playsInstrument,
          playsInstrumentRaw: data.playsInstrumentRaw,
          influencedByQids: data.influencedByQids,
        },
      );
    } else {
      await session.run(
        `MATCH (a:Artist {discogsId: $discogsId})
         SET a.wikidataFetchedAt = datetime()`,
        { discogsId: neo4j.int(discogsId) },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Clear every Wikidata-sourced property + the `wikidataFetchedAt` marker from all Artist nodes so
 * the next enrichment run re-resolves them from scratch. Also drops `influencedByQids` (#391) — the
 * raw P737 list the `artist-influences` pass reads; the derived `INFLUENCED_BY` edges are left as-is
 * (re-MERGEd exhaustively each run, like the other reconciliation passes — a from-scratch wipe is
 * `POST /reset?confirm=wipe-all`).
 */
export async function resetArtistWikidataEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Artist) WHERE a.wikidataFetchedAt IS NOT NULL
       REMOVE a.wikidataFetchedAt, a.wikidataQid, a.bornYear, a.bornDate,
              a.diedYear, a.diedDate, a.imageUrl, a.awards,
              a.playsInstrument, a.playsInstrumentRaw, a.influencedByQids
       RETURN count(a) AS reset`,
    );
    return (result.records[0]?.get('reset') as Neo4jInt | null)?.toNumber() ?? 0;
  } finally {
    await session.close();
  }
}
