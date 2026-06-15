import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { parseDisplayRole, parseRoleCategory, parseInstrument } from '../ingestion/transforms.js';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

/** A distinct recording MBID and every candidate Track node that carries it. */
export interface RecordingForArtists {
  recordingMbid: string;
  trackElementIds: string[];
}

/**
 * One performance credit ready to write: a person keyed by their MB artist MBID, with a single
 * combined `role` string (the enrichment aggregates a person's instrument/vocal/performer relations
 * into one credit, matching the one-`CREDITED_ON`-per-(person,track) model). The derived
 * display/category/instrument props are computed here from `role`, reusing the same transforms as
 * the Discogs credit path so MB credits stay queryable via `/explore/instrument/:name`.
 */
export interface RecordingArtistCredit {
  mbid: string;
  name: string;
  role: string;
}

/**
 * Fetch every distinct `recordingMbid` whose Tracks still LACK an MB-sourced track credit and whose
 * last attempt has aged past the staleness window (issue #89), grouped so one MusicBrainz recording
 * is looked up once and fanned out to every Track carrying it. Mirrors `getTracksForWorksEnrichment`:
 * the `recordingMbid IS NOT NULL` gate is what makes this stage depend on `track-musicbrainz` having
 * run first, and the `NOT EXISTS` guard keeps an already-credited Track from being re-fetched every
 * staleness window — only a still-uncredited one is. Forced re-fetch is the explicit
 * `/track-recording-artists/reset` route, per the *FetchedAt contract.
 */
export async function getTracksForRecordingArtistsEnrichment(
  driver: Driver,
): Promise<RecordingForArtists[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.recordingMbid IS NOT NULL
         AND NOT EXISTS {
           (t)<-[c:CREDITED_ON]-(:Musician)
           WHERE c.source = 'musicbrainz' AND c.scope = 'track'
         }
         AND (t.recordingArtistsFetchedAt IS NULL
              OR t.recordingArtistsFetchedAt < datetime() - duration({ days: $stalenessDays }))
       RETURN t.recordingMbid AS recordingMbid, collect(elementId(t)) AS trackElementIds`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((record) => ({
      recordingMbid: record.get('recordingMbid') as string,
      trackElementIds: record.get('trackElementIds') as string[],
    }));
  } finally {
    await session.close();
  }
}

/**
 * Write track-scoped `CREDITED_ON` edges for a recording's performance credits, stamping
 * `recordingArtistsFetchedAt` on every candidate Track.
 *
 * Person identity is a deterministic MB-artist-MBID join (#380), never name-matching: a Musician is
 * MERGEd by `musicbrainzId`, so an in-collection person already carrying that MBID (stamped by the
 * `mb-artist-id` pass) is reused, and an unresolved person gets an MBID-keyed fallback node
 * (provenance preserved — doubt recorded, not guessed away). The node is linked to any same-MBID
 * `Artist` via `SAME_PERSON_AS` so an Artist-only person still consolidates in explore queries.
 *
 * The credit props use `ON CREATE SET` so an existing (Discogs) credit for the same person/track is
 * never clobbered — MusicBrainz only fills gaps. `source: 'musicbrainz'` + the recording MBID record
 * provenance.
 */
export async function mergeRecordingArtistCredits(
  driver: Driver,
  recordingMbid: string,
  trackElementIds: string[],
  credits: RecordingArtistCredit[],
): Promise<void> {
  if (credits.length === 0 || trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $credits AS cr
       MERGE (m:Musician {musicbrainzId: cr.mbid})
         ON CREATE SET m.name = cr.name
       WITH DISTINCT m, cr
       OPTIONAL MATCH (a:Artist {musicbrainzId: cr.mbid})
       FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END |
         MERGE (m)-[:SAME_PERSON_AS]->(a))
       WITH DISTINCT m, cr
       UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       MERGE (m)-[co:CREDITED_ON]->(t)
         ON CREATE SET co.role = cr.role, co.displayRole = cr.displayRole,
                       co.roleCategory = cr.roleCategory, co.instrument = cr.instrument,
                       co.scope = 'track', co.source = 'musicbrainz', co.recordingMbid = $recordingMbid
       SET t.recordingArtistsFetchedAt = datetime()`,
      {
        recordingMbid,
        trackElementIds,
        credits: credits.map((c) => ({
          mbid: c.mbid,
          name: c.name,
          role: c.role,
          displayRole: parseDisplayRole(c.role),
          roleCategory: parseRoleCategory(c.role),
          instrument: parseInstrument(c.role),
        })),
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp `recordingArtistsFetchedAt` on a recording's Tracks without writing any credit — the
 * markAttempted path, reached when MusicBrainz returned no performance credits for the recording.
 * Throttles re-attempts to once per staleness window.
 */
export async function setRecordingArtistsFetched(
  driver: Driver,
  trackElementIds: string[],
): Promise<void> {
  if (trackElementIds.length === 0) return;

  const session = driver.session();
  try {
    await session.run(
      `UNWIND $trackElementIds AS eid
       MATCH (t:Track) WHERE elementId(t) = eid
       SET t.recordingArtistsFetchedAt = datetime()`,
      { trackElementIds },
    );
  } finally {
    await session.close();
  }
}

/**
 * Remove all track-recording-artists enrichment so a re-run reproduces it from scratch. Runs three
 * statements in one write transaction so a crash can't leave a half-reset graph:
 *   1. delete every MB-sourced track credit (`source: 'musicbrainz'`, `scope: 'track'`);
 *   2. `DETACH DELETE` the MBID-keyed fallback Musicians this stage created — their unambiguous
 *      signature is `musicbrainzId IS NOT NULL AND discogsId IS NULL` (name-only Musicians never get
 *      a musicbrainzId, and `mb-artist-id` only stamps discogsId-bearing nodes), so resolved persons
 *      are left intact;
 *   3. clear the `recordingArtistsFetchedAt` markers.
 * Returns the number of Tracks reset.
 */
export async function resetRecordingArtistsEnrichment(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    return await session.executeWrite(async (tx) => {
      await tx.run(
        `MATCH (:Musician)-[c:CREDITED_ON]->(:Track)
         WHERE c.source = 'musicbrainz' AND c.scope = 'track'
         DELETE c`,
      );
      await tx.run(
        `MATCH (m:Musician)
         WHERE m.musicbrainzId IS NOT NULL AND m.discogsId IS NULL
         DETACH DELETE m`,
      );
      const resetResult = await tx.run(
        `MATCH (t:Track) WHERE t.recordingArtistsFetchedAt IS NOT NULL
         REMOVE t.recordingArtistsFetchedAt
         RETURN count(t) AS reset`,
      );
      return (resetResult.records[0]?.get('reset') as Neo4jInt | undefined)?.toNumber() ?? 0;
    });
  } finally {
    await session.close();
  }
}
