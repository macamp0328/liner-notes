import neo4j, { Driver } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ReleaseListItem {
  discogsId: number;
  title: string;
  year: number | null;
  format: string | null;
  thumbUrl: string | null;
  artistName: string | null;
  labelName: string | null;
}

export interface TrackCredit {
  name: string;
  role: string;
  displayRole: string;
  creditedAs: string | null;
}

export interface Track {
  position: string;
  title: string;
  duration: string | null;
  lyrics: string | null;
  lyricsSource: string | null;
  musicians: TrackCredit[];
}

export interface ReleaseArtist {
  discogsId: number;
  name: string;
  role: string;
}

export interface ReleaseLabel {
  discogsId: number;
  name: string;
  catalogNumber: string;
}

export interface ReleaseCredit {
  name: string;
  role: string;
  displayRole: string;
  creditedAs: string | null;
}

export interface ReleaseFull extends ReleaseListItem {
  masterDiscogsId: number | null;
  releaseDate: string | null;
  notes: string | null;
  discogsUrl: string | null;
  communityRating: number | null;
  communityRatingCount: number | null;
  barcode: string | null;
  artists: ReleaseArtist[];
  labels: ReleaseLabel[];
  genres: string[];
  styles: string[];
  country: string | null;
  decade: string | null;
  studios: string[];
  tracks: Track[];
  credits: ReleaseCredit[];
}

export interface ArtistRelease {
  discogsId: number;
  title: string;
  year: number | null;
  format: string | null;
  thumbUrl: string | null;
  role: string;
}

export interface ArtistCredit {
  releaseDiscogsId: number;
  releaseTitle: string;
  role: string;
  displayRole: string;
  creditedAs: string | null;
  scope: string;
}

export interface ArtistFull {
  discogsId: number;
  name: string;
  realName: string | null;
  profile: string | null;
  releases: ArtistRelease[];
  credits: ArtistCredit[];
}

export interface LabelRelease {
  discogsId: number;
  title: string;
  year: number | null;
  format: string | null;
  thumbUrl: string | null;
  catalogNumber: string;
  artistName: string | null;
}

export interface LabelFull {
  discogsId: number;
  name: string;
  profile: string | null;
  contactInfo: string | null;
  releases: LabelRelease[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return v as number;
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v as string;
}

function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return v as number;
}

// ---------------------------------------------------------------------------
// listReleases
// ---------------------------------------------------------------------------

export async function listReleases(
  driver: Driver,
  skip: number,
  limit: number,
): Promise<{ items: ReleaseListItem[]; total: number }> {
  const session = driver.session();
  try {
    const countResult = await session.run('MATCH (r:Release) RETURN count(r) AS total');
    const totalRaw = countResult.records[0]?.get('total') as unknown;
    const total = toInt(totalRaw) ?? 0;

    const dataResult = await session.run(
      `MATCH (r:Release)
OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
OPTIONAL MATCH (r)-[:ON_LABEL]->(l:Label)
WITH r,
     [x IN collect(DISTINCT a.name) WHERE x IS NOT NULL | x] AS artistNames,
     [x IN collect(DISTINCT l.name) WHERE x IS NOT NULL | x] AS labelNames
RETURN r.discogsId AS discogsId, r.title AS title, r.year AS year,
       r.format AS format, r.thumbUrl AS thumbUrl,
       artistNames, labelNames
ORDER BY r.title ASC
SKIP $skip LIMIT $limit`,
      { skip: neo4j.int(skip), limit: neo4j.int(limit) },
    );

    const items: ReleaseListItem[] = dataResult.records.map((record) => {
      const artistNames = ([...(record.get('artistNames') as string[])] as string[]).sort();
      const labelNames = ([...(record.get('labelNames') as string[])] as string[]).sort();
      return {
        discogsId: toInt(record.get('discogsId') as unknown) ?? 0,
        title: toStr(record.get('title') as unknown) ?? '',
        year: toInt(record.get('year') as unknown),
        format: toStr(record.get('format') as unknown),
        thumbUrl: toStr(record.get('thumbUrl') as unknown),
        artistName: artistNames[0] ?? null,
        labelName: labelNames[0] ?? null,
      };
    });

    return { items, total };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleaseById
// ---------------------------------------------------------------------------

interface RawArtistMap {
  discogsId: unknown;
  name: unknown;
  role: unknown;
}

interface RawLabelMap {
  discogsId: unknown;
  name: unknown;
  catalogNumber: unknown;
}

interface RawCreditMap {
  name: unknown;
  role: unknown;
  displayRole: unknown;
  creditedAs: unknown;
}

export async function getReleaseById(
  driver: Driver,
  discogsId: number,
): Promise<ReleaseFull | null> {
  const session = driver.session();
  try {
    const coreResult = await session.run(
      `MATCH (r:Release {discogsId: $discogsId})
OPTIONAL MATCH (r)-[rb:RELEASED_BY]->(a:Artist)
OPTIONAL MATCH (r)-[ol:ON_LABEL]->(l:Label)
OPTIONAL MATCH (r)-[:IN_GENRE]->(g:Genre)
OPTIONAL MATCH (r)-[:IN_STYLE]->(s:Style)
OPTIONAL MATCH (r)-[:FROM_COUNTRY]->(c:Country)
OPTIONAL MATCH (r)-[:RECORDED_IN_DECADE]->(d:Decade)
OPTIONAL MATCH (r)-[:RECORDED_AT]->(st:Studio)
OPTIONAL MATCH (rm:Musician)-[rco:CREDITED_ON]->(r)
RETURN r,
  collect(DISTINCT {discogsId: a.discogsId, name: a.name, role: rb.role}) AS artists,
  collect(DISTINCT {discogsId: l.discogsId, name: l.name, catalogNumber: ol.catalogNumber}) AS labels,
  collect(DISTINCT g.name) AS genres,
  collect(DISTINCT s.name) AS styles,
  c.name AS country, d.name AS decade,
  collect(DISTINCT st.name) AS studios,
  collect(DISTINCT {name: rm.name, role: rco.role,
    displayRole: rco.displayRole, creditedAs: rco.creditedAs}) AS credits`,
      { discogsId: neo4j.int(discogsId) },
    );

    const rec = coreResult.records[0];
    if (!rec) return null;

    const r = rec.get('r') as { properties: Record<string, unknown> };
    const props = r.properties;

    const rawArtists = rec.get('artists') as RawArtistMap[];
    const artists: ReleaseArtist[] = rawArtists
      .filter((a) => a.discogsId !== null)
      .map((a) => ({
        discogsId: toInt(a.discogsId) ?? 0,
        name: toStr(a.name) ?? '',
        role: toStr(a.role) ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const rawLabels = rec.get('labels') as RawLabelMap[];
    const labels: ReleaseLabel[] = rawLabels
      .filter((l) => l.discogsId !== null)
      .map((l) => ({
        discogsId: toInt(l.discogsId) ?? 0,
        name: toStr(l.name) ?? '',
        catalogNumber: toStr(l.catalogNumber) ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const genres: string[] = (rec.get('genres') as unknown[])
      .filter((g): g is string => g !== null)
      .sort();
    const styles: string[] = (rec.get('styles') as unknown[])
      .filter((s): s is string => s !== null)
      .sort();
    const studios: string[] = (rec.get('studios') as unknown[])
      .filter((s): s is string => s !== null)
      .sort();

    const rawCredits = rec.get('credits') as RawCreditMap[];
    const credits: ReleaseCredit[] = rawCredits
      .filter((c) => c.name !== null)
      .map((c) => ({
        name: toStr(c.name) ?? '',
        role: toStr(c.role) ?? '',
        displayRole: toStr(c.displayRole) ?? '',
        creditedAs: toStr(c.creditedAs),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const tracksResult = await session.run(
      `MATCH (r:Release {discogsId: $discogsId})-[ht:HAS_TRACK]->(t:Track)
OPTIONAL MATCH (m:Musician)-[co:CREDITED_ON]->(t)
WITH t, ht.trackNumber AS trackNumber, collect({name: m.name, role: co.role,
     displayRole: co.displayRole, creditedAs: co.creditedAs}) AS musicians
RETURN t.position AS position, t.title AS title, t.duration AS duration,
       t.lyrics AS lyrics, t.lyricsSource AS lyricsSource, musicians
ORDER BY trackNumber ASC`,
      { discogsId: neo4j.int(discogsId) },
    );

    const tracks: Track[] = tracksResult.records.map((tr) => {
      const rawMusicians = tr.get('musicians') as RawCreditMap[];
      const musicians: TrackCredit[] = rawMusicians
        .filter((m) => m.name !== null)
        .map((m) => ({
          name: toStr(m.name) ?? '',
          role: toStr(m.role) ?? '',
          displayRole: toStr(m.displayRole) ?? '',
          creditedAs: toStr(m.creditedAs),
        }));
      return {
        position: toStr(tr.get('position') as unknown) ?? '',
        title: toStr(tr.get('title') as unknown) ?? '',
        duration: toStr(tr.get('duration') as unknown),
        lyrics: toStr(tr.get('lyrics') as unknown),
        lyricsSource: toStr(tr.get('lyricsSource') as unknown),
        musicians,
      };
    });

    return {
      discogsId: toInt(props['discogsId']) ?? 0,
      title: toStr(props['title']) ?? '',
      year: toInt(props['year']),
      format: toStr(props['format']),
      thumbUrl: toStr(props['thumbUrl']),
      artistName: artists[0]?.name ?? null,
      labelName: labels[0]?.name ?? null,
      masterDiscogsId: toInt(props['masterDiscogsId']),
      releaseDate: toStr(props['releaseDate']),
      notes: toStr(props['notes']),
      discogsUrl: toStr(props['discogsUrl']),
      communityRating: toFloat(props['communityRating']),
      communityRatingCount: toInt(props['communityRatingCount']),
      barcode: toStr(props['barcode']),
      artists,
      labels,
      genres,
      styles,
      country: toStr(rec.get('country') as unknown),
      decade: toStr(rec.get('decade') as unknown),
      studios,
      tracks,
      credits,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getArtistById
// ---------------------------------------------------------------------------

interface RawReleaseMap {
  discogsId: unknown;
  title: unknown;
  year: unknown;
  format: unknown;
  thumbUrl: unknown;
  role: unknown;
}

export async function getArtistById(driver: Driver, discogsId: number): Promise<ArtistFull | null> {
  const session = driver.session();
  try {
    const artistResult = await session.run(
      `MATCH (a:Artist {discogsId: $discogsId})
OPTIONAL MATCH (r:Release)-[rb:RELEASED_BY]->(a)
RETURN a.discogsId AS discogsId, a.name AS name,
       a.realName AS realName, a.profile AS profile,
  collect(DISTINCT {discogsId: r.discogsId, title: r.title, year: r.year,
    format: r.format, thumbUrl: r.thumbUrl, role: rb.role}) AS releases`,
      { discogsId: neo4j.int(discogsId) },
    );

    const rec = artistResult.records[0];
    if (!rec) return null;

    const rawReleases = rec.get('releases') as RawReleaseMap[];
    const releases: ArtistRelease[] = rawReleases
      .filter((r) => r.discogsId !== null)
      .map((r) => ({
        discogsId: toInt(r.discogsId) ?? 0,
        title: toStr(r.title) ?? '',
        year: toInt(r.year),
        format: toStr(r.format),
        thumbUrl: toStr(r.thumbUrl),
        role: toStr(r.role) ?? '',
      }))
      .sort((a, b) => {
        const yearDiff = (b.year ?? 0) - (a.year ?? 0);
        return yearDiff !== 0 ? yearDiff : a.title.localeCompare(b.title);
      });

    const creditsResult = await session.run(
      `MATCH (m:Musician)-[:SAME_PERSON_AS]->(a:Artist {discogsId: $discogsId})
MATCH (m)-[co:CREDITED_ON]->(target)
WHERE target:Release OR target:Track
WITH m, co, target,
     CASE WHEN target:Release THEN target ELSE null END AS creditRelease,
     CASE WHEN target:Track THEN target ELSE null END AS creditTrack
OPTIONAL MATCH (r2:Release)-[:HAS_TRACK]->(creditTrack)
WITH co, coalesce(creditRelease, r2) AS release
WHERE release IS NOT NULL
RETURN release.discogsId AS releaseDiscogsId, release.title AS releaseTitle,
       co.role AS role, co.displayRole AS displayRole,
       co.creditedAs AS creditedAs, co.scope AS scope`,
      { discogsId: neo4j.int(discogsId) },
    );

    const credits: ArtistCredit[] = creditsResult.records.map((cr) => ({
      releaseDiscogsId: toInt(cr.get('releaseDiscogsId') as unknown) ?? 0,
      releaseTitle: toStr(cr.get('releaseTitle') as unknown) ?? '',
      role: toStr(cr.get('role') as unknown) ?? '',
      displayRole: toStr(cr.get('displayRole') as unknown) ?? '',
      creditedAs: toStr(cr.get('creditedAs') as unknown),
      scope: toStr(cr.get('scope') as unknown) ?? '',
    }));

    return {
      discogsId: toInt(rec.get('discogsId') as unknown) ?? 0,
      name: toStr(rec.get('name') as unknown) ?? '',
      realName: toStr(rec.get('realName') as unknown),
      profile: toStr(rec.get('profile') as unknown),
      releases,
      credits,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getLabelById
// ---------------------------------------------------------------------------

interface RawLabelReleaseMap {
  discogsId: unknown;
  title: unknown;
  year: unknown;
  format: unknown;
  thumbUrl: unknown;
  catalogNumber: unknown;
  artistNames: unknown;
}

export async function getLabelById(driver: Driver, discogsId: number): Promise<LabelFull | null> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (l:Label {discogsId: $discogsId})
OPTIONAL MATCH (r:Release)-[ol:ON_LABEL]->(l)
OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
WITH l, r, ol, [x IN collect(DISTINCT a.name) WHERE x IS NOT NULL | x] AS artistNames
RETURN l.discogsId AS discogsId, l.name AS name,
       l.profile AS profile, l.contactInfo AS contactInfo,
  collect(DISTINCT {discogsId: r.discogsId, title: r.title, year: r.year,
    format: r.format, thumbUrl: r.thumbUrl,
    catalogNumber: ol.catalogNumber, artistNames: artistNames}) AS releases`,
      { discogsId: neo4j.int(discogsId) },
    );

    const rec = result.records[0];
    if (!rec) return null;

    const rawReleases = rec.get('releases') as RawLabelReleaseMap[];
    const releases: LabelRelease[] = rawReleases
      .filter((r) => r.discogsId !== null)
      .map((r) => ({
        discogsId: toInt(r.discogsId) ?? 0,
        title: toStr(r.title) ?? '',
        year: toInt(r.year),
        format: toStr(r.format),
        thumbUrl: toStr(r.thumbUrl),
        catalogNumber: toStr(r.catalogNumber) ?? '',
        artistName: ([...(r.artistNames as string[])].sort()[0] as string | undefined) ?? null,
      }))
      .sort((a, b) => {
        const yearDiff = (b.year ?? 0) - (a.year ?? 0);
        return yearDiff !== 0 ? yearDiff : a.title.localeCompare(b.title);
      });

    return {
      discogsId: toInt(rec.get('discogsId') as unknown) ?? 0,
      name: toStr(rec.get('name') as unknown) ?? '',
      profile: toStr(rec.get('profile') as unknown),
      contactInfo: toStr(rec.get('contactInfo') as unknown),
      releases,
    };
  } finally {
    await session.close();
  }
}
