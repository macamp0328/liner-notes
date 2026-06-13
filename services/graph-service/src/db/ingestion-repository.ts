// Cypher MERGE queries for the Discogs ingestion pipeline.
// All writes are idempotent — re-running produces the same graph state.
// Keep all query logic in this file; never inline Cypher in the pipeline.

import type { Driver, Session } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import type {
  DiscogsArtistCredit,
  DiscogsCompany,
  DiscogsLabel,
  DiscogsRelease,
  DiscogsTracklistEntry,
} from '../ingestion/types.js';
import {
  extractBarcode,
  extractStudios,
  extractThumbUrl,
  filterTracks,
  isInstrumental,
  normalizeCountry,
  parseDisplayRole,
  parseRoleCategory,
  parseInstrument,
  parseDurationSeconds,
} from '../ingestion/transforms.js';

const VARIOUS_ARTISTS_IDS = [194, 355];

/**
 * Check whether any Release nodes exist in the graph.
 * Used by the server onReady hook to decide whether to auto-trigger ingestion.
 */
export async function hasReleases(driver: Driver): Promise<boolean> {
  const session = driver.session();
  try {
    // RETURN 1 LIMIT 1 short-circuits on the first match — avoids a full count scan.
    const result = await session.run('MATCH (r:Release) RETURN 1 AS exists LIMIT 1');
    return result.records.length > 0;
  } finally {
    await session.close();
  }
}

/**
 * Delete every node and relationship in the graph. Returns the number of nodes
 * removed. Destructive and irreversible — intended for a deliberate "wipe and
 * reload from scratch" (the graph is fully reconstructable from Discogs). The
 * collection is small (~200 releases / a few thousand nodes), so a single
 * DETACH DELETE is well within Aura's transaction limits.
 */
export async function wipeGraph(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run('MATCH (n) DETACH DELETE n RETURN count(n) AS deleted');
    const raw = result.records[0]?.get('deleted') as { toNumber(): number } | number | null;
    if (raw === null || raw === undefined) return 0;
    return typeof (raw as { toNumber(): number }).toNumber === 'function'
      ? (raw as { toNumber(): number }).toNumber()
      : (raw as number);
  } finally {
    await session.close();
  }
}

/**
 * Merge all nodes and relationships for a single Discogs release.
 * Opens one session; all sub-operations run sequentially within it.
 * Each MERGE is idempotent — safe to call multiple times with the same data.
 */
export async function mergeReleaseGraph(driver: Driver, release: DiscogsRelease): Promise<void> {
  // The release id is the primary key every node in the graph MERGEs against; a null id
  // cannot be keyed and has no name-only fallback (unlike artists/labels/credits). Fail loud
  // and legible here instead of letting `neo4j.int(null)` throw a cryptic "reading 'low'"
  // deep in the merge path. The per-release try/catch in runIngestion logs and continues.
  if (release.id == null) {
    throw new Error(`Cannot ingest release with no id (title: "${release.title}")`);
  }
  const session = driver.session();
  try {
    await mergeRelease(session, release);
    await mergeArtists(session, release.id, release.artists);
    await mergeLabels(session, release.id, release.labels);
    await mergeGenres(session, release.id, release.genres ?? []);
    await mergeStyles(session, release.id, release.styles ?? []);
    if (release.country) {
      const normalizedCountries = normalizeCountry(release.country);
      await mergeCountry(session, release.id, normalizedCountries);
    }
    await mergeStudios(session, release.id, release.companies ?? []);
    const tracks = filterTracks(release.tracklist);
    await mergeTracks(session, release.id, tracks);
    await mergeReleaseCredits(session, release.id, release.extraartists ?? []);
    await mergeTrackCredits(session, release.id, tracks);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Private helpers — one function per entity/relationship group
// ---------------------------------------------------------------------------

async function mergeRelease(session: Session, release: DiscogsRelease): Promise<void> {
  const images = release.images ?? [];
  const identifiers = release.identifiers ?? [];
  const thumbUrl = extractThumbUrl(images);
  const barcode = extractBarcode(identifiers);
  const format = release.formats[0]?.name ?? null;
  const masterDiscogsId =
    release.master_id && release.master_id !== 0 ? neo4j.int(release.master_id) : null;
  const communityRating = release.community?.rating?.average ?? null;
  const communityRatingCount =
    release.community?.rating?.count != null ? neo4j.int(release.community.rating.count) : null;
  const pressingYear = release.year > 0 ? neo4j.int(release.year) : null;
  const primaryArtist = release.artists[0];
  const isVariousArtists =
    primaryArtist != null
      ? (primaryArtist.id != null && VARIOUS_ARTISTS_IDS.includes(primaryArtist.id)) ||
        ['various', 'various artists'].includes(primaryArtist.name.toLowerCase())
      : false;

  await session.run(
    `MERGE (r:Release {discogsId: $discogsId})
     ON CREATE SET
       r.title              = $title,
       r.pressingYear       = $pressingYear,
       r.isVariousArtists   = $isVariousArtists,
       r.format             = $format,
       r.thumbUrl           = $thumbUrl,
       r.masterDiscogsId    = $masterDiscogsId,
       r.releaseDate        = $releaseDate,
       r.notes              = $notes,
       r.discogsUrl         = $discogsUrl,
       r.communityRating    = $communityRating,
       r.communityRatingCount = $communityRatingCount,
       r.barcode            = $barcode
     ON MATCH SET
       r.title              = $title,
       r.pressingYear       = $pressingYear,
       r.isVariousArtists   = $isVariousArtists,
       r.format             = $format,
       r.thumbUrl           = $thumbUrl,
       r.masterDiscogsId    = $masterDiscogsId,
       r.releaseDate        = $releaseDate,
       r.notes              = $notes,
       r.discogsUrl         = $discogsUrl,
       r.communityRating    = $communityRating,
       r.communityRatingCount = $communityRatingCount,
       r.barcode            = $barcode`,
    {
      discogsId: neo4j.int(release.id),
      title: release.title,
      pressingYear,
      isVariousArtists,
      format,
      thumbUrl,
      masterDiscogsId,
      releaseDate: release.released ?? null,
      notes: release.notes ?? null,
      discogsUrl: release.uri,
      communityRating,
      communityRatingCount,
      barcode,
    },
  );
}

async function mergeArtists(
  session: Session,
  releaseId: number,
  artists: DiscogsArtistCredit[],
): Promise<void> {
  for (const artist of artists) {
    // id=0 (not in Discogs DB) or null (malformed/omitted, issue #181) are both unkeyable — skip.
    if (artist.id == null || artist.id === 0) continue;
    await session.run(
      `MERGE (a:Artist {discogsId: $discogsId})
       ON CREATE SET a.name = $name
       ON MATCH SET  a.name = $name
       WITH a
       MATCH (r:Release {discogsId: $releaseId})
       MERGE (r)-[:RELEASED_BY {role: ""}]->(a)`,
      {
        discogsId: neo4j.int(artist.id),
        name: artist.name,
        releaseId: neo4j.int(releaseId),
      },
    );
  }
}

async function mergeLabels(
  session: Session,
  releaseId: number,
  labels: DiscogsLabel[],
): Promise<void> {
  for (const label of labels) {
    if (label.id == null || label.id === 0) continue; // unkeyable (id=0 or null) — skip
    await session.run(
      `MERGE (l:Label {discogsId: $discogsId})
       ON CREATE SET l.name = $name
       ON MATCH SET  l.name = $name
       WITH l
       MATCH (r:Release {discogsId: $releaseId})
       MERGE (r)-[:ON_LABEL {catalogNumber: $catalogNumber}]->(l)`,
      {
        discogsId: neo4j.int(label.id),
        name: label.name,
        releaseId: neo4j.int(releaseId),
        catalogNumber: label.catno,
      },
    );
  }
}

async function mergeGenres(session: Session, releaseId: number, genres: string[]): Promise<void> {
  for (const genre of genres) {
    await session.run(
      `MERGE (g:Genre {name: $name})
       WITH g
       MATCH (r:Release {discogsId: $releaseId})
       MERGE (r)-[:IN_GENRE]->(g)`,
      { name: genre, releaseId: neo4j.int(releaseId) },
    );
  }
}

async function mergeStyles(session: Session, releaseId: number, styles: string[]): Promise<void> {
  for (const style of styles) {
    await session.run(
      `MERGE (s:Style {name: $name})
       WITH s
       MATCH (r:Release {discogsId: $releaseId})
       MERGE (r)-[:IN_STYLE]->(s)`,
      { name: style, releaseId: neo4j.int(releaseId) },
    );
  }
}

async function mergeCountry(
  session: Session,
  releaseId: number,
  countries: string[],
): Promise<void> {
  for (const country of countries) {
    await session.run(
      `MERGE (c:Country {name: $name})
       WITH c
       MATCH (r:Release {discogsId: $releaseId})
       MERGE (r)-[:FROM_COUNTRY]->(c)`,
      { name: country, releaseId: neo4j.int(releaseId) },
    );
  }
}

async function mergeStudios(
  session: Session,
  releaseId: number,
  companies: DiscogsCompany[],
): Promise<void> {
  const studios = extractStudios(companies);
  for (const studio of studios) {
    await session.run(
      `MERGE (s:Studio {name: $name})
       WITH s
       MATCH (r:Release {discogsId: $releaseId})
       MERGE (r)-[:RECORDED_AT]->(s)`,
      { name: studio.name, releaseId: neo4j.int(releaseId) },
    );
  }
}

async function mergeTracks(
  session: Session,
  releaseId: number,
  tracks: DiscogsTracklistEntry[],
): Promise<void> {
  // `tracks` is already filterTracks-filtered (real "track" entries only) and Discogs
  // returns it in album order, so the array index is the release-global track ordinal.
  for (const [index, track] of tracks.entries()) {
    // Track MERGE key: (position + releaseDiscogsId) — no unique constraint on Track,
    // so we store releaseDiscogsId as a property to uniquely identify tracks across releases.
    const duration = track.duration === '' ? null : track.duration;
    const durationSeconds = parseDurationSeconds(track.duration);
    const instrumental = isInstrumental(track);
    await session.run(
      `MERGE (t:Track {position: $position, releaseDiscogsId: $releaseDiscogsId})
       ON CREATE SET t.title = $title,
                     t.duration = $duration,
                     t.durationSeconds = $durationSeconds, t.isInstrumental = $isInstrumental
       ON MATCH SET  t.title = $title,
                     t.duration = $duration,
                     t.durationSeconds = $durationSeconds, t.isInstrumental = $isInstrumental
       WITH t
       MATCH (r:Release {discogsId: $releaseDiscogsId})
       MERGE (r)-[ht:HAS_TRACK]->(t)
       SET ht.trackNumber = $trackNumber`,
      {
        position: track.position,
        releaseDiscogsId: neo4j.int(releaseId),
        title: track.title,
        duration,
        durationSeconds: durationSeconds != null ? neo4j.int(durationSeconds) : null,
        isInstrumental: instrumental,
        trackNumber: neo4j.int(index + 1),
      },
    );
  }
}

/**
 * Merge release-level musician credits (from release.extraartists).
 * Creates CREDITED_ON relationships from Musician → Release with scope:"release".
 */
async function mergeReleaseCredits(
  session: Session,
  releaseId: number,
  extraartists: DiscogsArtistCredit[],
): Promise<void> {
  for (const credit of extraartists) {
    const creditedAs = credit.anv !== '' ? credit.anv : null;
    const displayRole = parseDisplayRole(credit.role);
    const roleCategory = parseRoleCategory(credit.role);
    const instrument = parseInstrument(credit.role);

    if (credit.id != null && credit.id !== 0) {
      // Musician with a Discogs ID — merge by discogsId for deduplication
      await session.run(
        `MERGE (m:Musician {discogsId: $discogsId})
         ON CREATE SET m.name = $name
         ON MATCH SET  m.name = $name
         WITH m
         MATCH (r:Release {discogsId: $releaseId})
         MERGE (m)-[co:CREDITED_ON]->(r)
         SET co.role = $role, co.displayRole = $displayRole,
             co.roleCategory = $roleCategory, co.instrument = $instrument,
             co.creditedAs = $creditedAs, co.scope = "release"`,
        {
          discogsId: neo4j.int(credit.id),
          name: credit.name,
          releaseId: neo4j.int(releaseId),
          role: credit.role,
          displayRole,
          roleCategory,
          instrument,
          creditedAs,
        },
      );

      // If an Artist node with the same discogsId exists, link them
      await mergeSamePersonAs(session, credit.id);
    } else {
      // id 0 or null: person not in / omitted by Discogs DB — merge by name only, no discogsId set
      await session.run(
        `MERGE (m:Musician {name: $name})
         WITH m
         MATCH (r:Release {discogsId: $releaseId})
         MERGE (m)-[co:CREDITED_ON]->(r)
         SET co.role = $role, co.displayRole = $displayRole,
             co.roleCategory = $roleCategory, co.instrument = $instrument,
             co.creditedAs = $creditedAs, co.scope = "release"`,
        {
          name: credit.name,
          releaseId: neo4j.int(releaseId),
          role: credit.role,
          displayRole,
          roleCategory,
          instrument,
          creditedAs,
        },
      );
    }
  }
}

/**
 * Merge per-track musician credits (from tracklist[n].extraartists).
 * Creates CREDITED_ON relationships from Musician → Track with scope:"track".
 * Track-level credits provide the richest musician-graph data.
 */
async function mergeTrackCredits(
  session: Session,
  releaseId: number,
  tracks: DiscogsTracklistEntry[],
): Promise<void> {
  for (const track of tracks) {
    for (const credit of track.extraartists ?? []) {
      const creditedAs = credit.anv !== '' ? credit.anv : null;
      const displayRole = parseDisplayRole(credit.role);
      const roleCategory = parseRoleCategory(credit.role);
      const instrument = parseInstrument(credit.role);

      if (credit.id != null && credit.id !== 0) {
        await session.run(
          `MERGE (m:Musician {discogsId: $discogsId})
           ON CREATE SET m.name = $name
           ON MATCH SET  m.name = $name
           WITH m
           MATCH (t:Track {position: $position, releaseDiscogsId: $releaseDiscogsId})
           MERGE (m)-[co:CREDITED_ON]->(t)
           SET co.role = $role, co.displayRole = $displayRole,
               co.roleCategory = $roleCategory, co.instrument = $instrument,
               co.creditedAs = $creditedAs, co.scope = "track"`,
          {
            discogsId: neo4j.int(credit.id),
            name: credit.name,
            position: track.position,
            releaseDiscogsId: neo4j.int(releaseId),
            role: credit.role,
            displayRole,
            roleCategory,
            instrument,
            creditedAs,
          },
        );

        await mergeSamePersonAs(session, credit.id);
      } else {
        // id 0 or null: name-only musician node
        await session.run(
          `MERGE (m:Musician {name: $name})
           WITH m
           MATCH (t:Track {position: $position, releaseDiscogsId: $releaseDiscogsId})
           MERGE (m)-[co:CREDITED_ON]->(t)
           SET co.role = $role, co.displayRole = $displayRole,
               co.roleCategory = $roleCategory, co.instrument = $instrument,
               co.creditedAs = $creditedAs, co.scope = "track"`,
          {
            name: credit.name,
            position: track.position,
            releaseDiscogsId: neo4j.int(releaseId),
            role: credit.role,
            displayRole,
            roleCategory,
            instrument,
            creditedAs,
          },
        );
      }
    }
  }
}

/**
 * If an Artist node exists with the same discogsId as a Musician, create a SAME_PERSON_AS link.
 * Called after every Musician MERGE where id !== 0.
 */
async function mergeSamePersonAs(session: Session, discogsId: number): Promise<void> {
  await session.run(
    `MATCH (m:Musician {discogsId: $discogsId})
     MATCH (a:Artist {discogsId: $discogsId})
     MERGE (m)-[:SAME_PERSON_AS]->(a)`,
    { discogsId: neo4j.int(discogsId) },
  );
}
