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
  deriveDecade,
  extractBarcode,
  extractStudios,
  extractThumbUrl,
  filterTracks,
  isInstrumental,
  parseDisplayRole,
  parseDurationSeconds,
  parseTrackNumber,
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
 * Merge all nodes and relationships for a single Discogs release.
 * Opens one session; all sub-operations run sequentially within it.
 * Each MERGE is idempotent — safe to call multiple times with the same data.
 */
export async function mergeReleaseGraph(driver: Driver, release: DiscogsRelease): Promise<void> {
  const session = driver.session();
  try {
    await mergeRelease(session, release);
    await mergeArtists(session, release.id, release.artists);
    await mergeLabels(session, release.id, release.labels);
    await mergeGenres(session, release.id, release.genres ?? []);
    await mergeStyles(session, release.id, release.styles ?? []);
    if (release.country) {
      await mergeCountry(session, release.id, release.country);
    }
    if (release.year > 0) {
      await mergeDecade(session, release.id, release.year);
    } else {
      // Remove any stale RECORDED_IN_DECADE link created before the year-0 guard was added.
      await session.run(
        `MATCH (r:Release {discogsId: $discogsId})-[rel:RECORDED_IN_DECADE]->(:Decade)
         DELETE rel`,
        { discogsId: neo4j.int(release.id) },
      );
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
      ? VARIOUS_ARTISTS_IDS.includes(primaryArtist.id) ||
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
    if (artist.id === 0) continue; // primary artists with id=0 are malformed data — skip
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
    if (label.id === 0) continue;
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

async function mergeCountry(session: Session, releaseId: number, country: string): Promise<void> {
  await session.run(
    `MERGE (c:Country {name: $name})
     WITH c
     MATCH (r:Release {discogsId: $releaseId})
     MERGE (r)-[:FROM_COUNTRY]->(c)`,
    { name: country, releaseId: neo4j.int(releaseId) },
  );
}

async function mergeDecade(session: Session, releaseId: number, year: number): Promise<void> {
  const decade = deriveDecade(year);
  await session.run(
    `MERGE (d:Decade {name: $name})
     WITH d
     MATCH (r:Release {discogsId: $releaseId})
     MERGE (r)-[:RECORDED_IN_DECADE]->(d)`,
    { name: decade, releaseId: neo4j.int(releaseId) },
  );
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
  for (const track of tracks) {
    // Track MERGE key: (position + releaseDiscogsId) — no unique constraint on Track,
    // so we store releaseDiscogsId as a property to uniquely identify tracks across releases.
    const duration = track.duration === '' ? null : track.duration;
    const durationSeconds = parseDurationSeconds(track.duration);
    const instrumental = isInstrumental(track);
    await session.run(
      `MERGE (t:Track {position: $position, releaseDiscogsId: $releaseDiscogsId})
       ON CREATE SET t.title = $title, t.duration = $duration,
                     t.durationSeconds = $durationSeconds, t.isInstrumental = $isInstrumental
       ON MATCH SET  t.title = $title, t.duration = $duration,
                     t.durationSeconds = $durationSeconds, t.isInstrumental = $isInstrumental
       WITH t
       MATCH (r:Release {discogsId: $releaseDiscogsId})
       MERGE (r)-[:HAS_TRACK {trackNumber: $trackNumber}]->(t)`,
      {
        position: track.position,
        releaseDiscogsId: neo4j.int(releaseId),
        title: track.title,
        duration,
        durationSeconds: durationSeconds != null ? neo4j.int(durationSeconds) : null,
        isInstrumental: instrumental,
        trackNumber: neo4j.int(parseTrackNumber(track.position)),
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

    if (credit.id !== 0) {
      // Musician with a Discogs ID — merge by discogsId for deduplication
      await session.run(
        `MERGE (m:Musician {discogsId: $discogsId})
         ON CREATE SET m.name = $name
         ON MATCH SET  m.name = $name
         WITH m
         MATCH (r:Release {discogsId: $releaseId})
         MERGE (m)-[co:CREDITED_ON]->(r)
         SET co.role = $role, co.displayRole = $displayRole,
             co.creditedAs = $creditedAs, co.scope = "release"`,
        {
          discogsId: neo4j.int(credit.id),
          name: credit.name,
          releaseId: neo4j.int(releaseId),
          role: credit.role,
          displayRole,
          creditedAs,
        },
      );

      // If an Artist node with the same discogsId exists, link them
      await mergeSamePersonAs(session, credit.id);
    } else {
      // id === 0: person not in Discogs DB — merge by name only, no discogsId set
      await session.run(
        `MERGE (m:Musician {name: $name})
         WITH m
         MATCH (r:Release {discogsId: $releaseId})
         MERGE (m)-[co:CREDITED_ON]->(r)
         SET co.role = $role, co.displayRole = $displayRole,
             co.creditedAs = $creditedAs, co.scope = "release"`,
        {
          name: credit.name,
          releaseId: neo4j.int(releaseId),
          role: credit.role,
          displayRole,
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

      if (credit.id !== 0) {
        await session.run(
          `MERGE (m:Musician {discogsId: $discogsId})
           ON CREATE SET m.name = $name
           ON MATCH SET  m.name = $name
           WITH m
           MATCH (t:Track {position: $position, releaseDiscogsId: $releaseDiscogsId})
           MERGE (m)-[co:CREDITED_ON]->(t)
           SET co.role = $role, co.displayRole = $displayRole,
               co.creditedAs = $creditedAs, co.scope = "track"`,
          {
            discogsId: neo4j.int(credit.id),
            name: credit.name,
            position: track.position,
            releaseDiscogsId: neo4j.int(releaseId),
            role: credit.role,
            displayRole,
            creditedAs,
          },
        );

        await mergeSamePersonAs(session, credit.id);
      } else {
        // id === 0: name-only musician node
        await session.run(
          `MERGE (m:Musician {name: $name})
           WITH m
           MATCH (t:Track {position: $position, releaseDiscogsId: $releaseDiscogsId})
           MERGE (m)-[co:CREDITED_ON]->(t)
           SET co.role = $role, co.displayRole = $displayRole,
               co.creditedAs = $creditedAs, co.scope = "track"`,
          {
            name: credit.name,
            position: track.position,
            releaseDiscogsId: neo4j.int(releaseId),
            role: credit.role,
            displayRole,
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
