import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getStalenessDays } from '../enrichment/staleness.js';

type Neo4jInt = { toNumber(): number };

export interface UnenrichedTrack {
  title: string;
  position: string;
  releaseDiscogsId: number;
  artistName: string | null;
  // The AcousticBrainz "voice" | "instrumental" classifier output already stored on the Track
  // (null until track-acousticbrainz runs). Used as the lower-certainty probable-instrumental
  // signal when LRCLIB has no record (issue #246).
  voiceInstrumental: string | null;
  // The Discogs track duration in seconds (null when unlisted), used by the match-confidence gate
  // (#248) to confirm a candidate is the same recording, not a same-title live/remix version.
  durationSeconds: number | null;
}

/**
 * Query Track nodes that still have no lyrics and whose last attempt has aged past the
 * staleness window (issue #89). Unlike the other enrichments, lyrics has no successful
 * data to gate on beyond `lyrics IS NULL`; `lyricsFetchedAt` throttles re-attempts of
 * still-empty tracks to once per window instead of every run (LRCLIB/Genius coverage may
 * improve, so a track is never given up on permanently — just throttled).
 *
 * Tracks classified `instrumental` / `probable-instrumental` are terminal and excluded (#246):
 * they have no lyrics by nature, so re-attempting them just wastes a Genius call. The
 * `coalesce(t.lyricsStatus, '')` guard is load-bearing — a bare `NOT t.lyricsStatus IN [...]`
 * evaluates to `null` on never-classified (NULL-status) rows and would drop every such track.
 * `low-confidence` (#248) is deliberately NOT in the exclusion list — it is non-terminal, so a
 * rejected match stays a candidate (a better catalog match or retuned threshold can upgrade it).
 *
 * Returns artist name from the Release's RELEASED_BY relationship (first artist when multiple),
 * plus the stored `voiceInstrumental` and `durationSeconds` so `resolve` can apply the secondary
 * signal and the match-confidence duration check in one query.
 */
export async function getUnenrichedTracks(driver: Driver): Promise<UnenrichedTrack[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
       WHERE t.lyrics IS NULL
         AND NOT (coalesce(t.lyricsStatus, '') IN ['instrumental', 'probable-instrumental'])
         AND (t.lyricsFetchedAt IS NULL
              OR t.lyricsFetchedAt < datetime() - duration({ days: $stalenessDays }))
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH t, collect(a.name)[0] AS artistName
       RETURN t.title AS title, t.position AS position,
              t.releaseDiscogsId AS releaseDiscogsId, artistName,
              t.voiceInstrumental AS voiceInstrumental,
              t.durationSeconds AS durationSeconds`,
      { stalenessDays: neo4j.int(getStalenessDays()) },
    );
    return result.records.map((record) => {
      const rawId = record.get('releaseDiscogsId') as { toNumber(): number };
      const rawDuration = record.get('durationSeconds') as { toNumber(): number } | null;
      return {
        title: record.get('title') as string,
        position: record.get('position') as string,
        releaseDiscogsId: rawId.toNumber(),
        artistName: record.get('artistName') as string | null,
        voiceInstrumental: record.get('voiceInstrumental') as string | null,
        durationSeconds: rawDuration === null ? null : rawDuration.toNumber(),
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Update a Track node with lyrics and the source that provided them, stamping
 * `lyricsFetchedAt = datetime()` so a successful track is excluded by `lyrics IS NULL`
 * and the timestamp records the attempt. Also sets `lyricsStatus = 'resolved'` (#246) and the
 * match-confidence provenance — `lyricsConfidence` plus the title/artist the source matched on
 * (#248) — so a stored lyric carries an auditable record of *why* it was accepted.
 * Track is identified by the Release it belongs to (discogsId) and its position.
 */
export async function setTrackLyrics(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
  lyrics: string,
  lyricsSource: 'lrclib' | 'genius',
  confidence: number,
  matchedTitle: string | null,
  matchedArtist: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.lyrics = $lyrics, t.lyricsSource = $lyricsSource,
           t.lyricsStatus = 'resolved', t.lyricsFetchedAt = datetime(),
           t.lyricsConfidence = $confidence,
           t.lyricsMatchedTitle = $matchedTitle, t.lyricsMatchedArtist = $matchedArtist`,
      {
        releaseDiscogsId: neo4j.int(releaseDiscogsId),
        position,
        lyrics,
        lyricsSource,
        confidence,
        matchedTitle,
        matchedArtist,
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp a `low-confidence` lyrics classification on a Track (#248): a source returned lyrics but
 * the match-confidence gate rejected them (low title/artist similarity, or a duration mismatch), so
 * the lyric text is NOT stored (`lyrics` stays null — honest coverage and the fulltext index stay
 * clean), but the confidence score and the source's matched title/artist ARE stored so the doubt is
 * visible and auditable. `lyricsFetchedAt` is stamped; the track is non-terminal and stays a
 * candidate (throttled per staleness window). Track is identified by the Release (discogsId) and
 * its position.
 */
export async function markTrackLowConfidence(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
  lyricsSource: 'lrclib' | 'genius',
  confidence: number,
  matchedTitle: string | null,
  matchedArtist: string | null,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.lyricsStatus = 'low-confidence', t.lyricsSource = $lyricsSource,
           t.lyricsFetchedAt = datetime(), t.lyricsConfidence = $confidence,
           t.lyricsMatchedTitle = $matchedTitle, t.lyricsMatchedArtist = $matchedArtist`,
      {
        releaseDiscogsId: neo4j.int(releaseDiscogsId),
        position,
        lyricsSource,
        confidence,
        matchedTitle,
        matchedArtist,
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Stamp a terminal lyrics classification on a Track without writing lyrics — `lyricsStatus`
 * is set to the given status and `lyricsFetchedAt = datetime()`; `lyrics` stays null. Used for
 * `instrumental` (LRCLIB authoritative) and `probable-instrumental` (AcousticBrainz signal),
 * both of which `getUnenrichedTracks` excludes so the track is never re-attempted (#246).
 * Track is identified by the Release it belongs to (discogsId) and its position.
 */
async function setLyricsStatus(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
  status: 'instrumental' | 'probable-instrumental',
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.lyricsStatus = $status, t.lyricsFetchedAt = datetime()`,
      { releaseDiscogsId: neo4j.int(releaseDiscogsId), position, status },
    );
  } finally {
    await session.close();
  }
}

/** Mark a Track terminally instrumental (LRCLIB's authoritative flag, #246). */
export async function markTrackInstrumental(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
): Promise<void> {
  return setLyricsStatus(driver, releaseDiscogsId, position, 'instrumental');
}

/** Mark a Track probable-instrumental (the lower-certainty AcousticBrainz signal, #246). */
export async function markTrackProbableInstrumental(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
): Promise<void> {
  return setLyricsStatus(driver, releaseDiscogsId, position, 'probable-instrumental');
}

/**
 * Stamp `lyricsFetchedAt = datetime()` and `lyricsStatus = 'not-found'` on a Track without
 * writing lyrics — used when a lookup completed but found nothing (LRCLIB + Genius both empty,
 * or no Genius token). `not-found` is non-terminal: the track stays a candidate (lyrics may
 * appear later, or the AcousticBrainz signal may arrive and upgrade it to probable-instrumental),
 * just throttled to one retry per staleness window. Not called on transient errors, so those
 * still retry on the next run.
 * Track is identified by the Release it belongs to (discogsId) and its position.
 */
export async function markLyricsFetched(
  driver: Driver,
  releaseDiscogsId: number,
  position: string,
): Promise<void> {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (r:Release {discogsId: $releaseDiscogsId})-[:HAS_TRACK]->(t:Track {position: $position})
       SET t.lyricsStatus = 'not-found', t.lyricsFetchedAt = datetime()`,
      { releaseDiscogsId: neo4j.int(releaseDiscogsId), position },
    );
  } finally {
    await session.close();
  }
}

/**
 * Null out all Track nodes enriched from Genius, including their `lyricsFetchedAt` stamp so
 * each cleared track becomes an immediate re-enrichment candidate rather than staying
 * throttled behind its old timestamp for the rest of the staleness window. Also clears
 * `lyricsStatus` (#246) — otherwise a cleared track keeps a stale `'resolved'` status with
 * null lyrics, contradicting the funnel invariant (resolved ⇔ lyrics present) — and the
 * match-confidence provenance (#248), so a cleared track keeps no stale confidence/matched fields.
 * Returns the count of tracks cleared.
 */
export async function clearGeniusLyrics(driver: Driver): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (t:Track)
       WHERE t.lyricsSource = 'genius'
       SET t.lyrics = null, t.lyricsSource = null, t.lyricsStatus = null, t.lyricsFetchedAt = null,
           t.lyricsConfidence = null, t.lyricsMatchedTitle = null, t.lyricsMatchedArtist = null
       RETURN count(t) AS cleared`,
    );
    const raw = result.records[0]?.get('cleared') as Neo4jInt | number | null | undefined;
    if (raw === null || raw === undefined) return 0;
    return typeof (raw as Neo4jInt).toNumber === 'function'
      ? (raw as Neo4jInt).toNumber()
      : (raw as number);
  } finally {
    await session.close();
  }
}
