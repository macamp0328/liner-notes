import neo4j, { Driver } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ExploreRelease {
  discogsId: number;
  title: string;
  artist: string | null;
  pressingYear: number | null;
  format: string | null;
  thumbUrl: string | null;
}

export interface MusicianRelease extends ExploreRelease {
  instrument: string | null;
  role: string | null;
}

export interface ConnectionNode {
  type: string;
  discogsId: number | null;
  name: string | null;
  title: string | null;
}

export interface ConnectionsResult {
  seed: ExploreRelease;
  nodes: ConnectionNode[];
}

export interface SharedMusician {
  name: string;
  instrument: string | null;
}

export interface SharedMusiciansResult {
  releaseA: { discogsId: number; title: string };
  releaseB: { discogsId: number; title: string };
  sharedMusicians: SharedMusician[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && val !== null && 'toNumber' in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  if (typeof val === 'number') return val;
  return null;
}

function toStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return String(val);
}

function mapExploreRelease(record: { get: (key: string) => unknown }): ExploreRelease {
  return {
    discogsId: toInt(record.get('discogsId')) ?? 0,
    title: toStr(record.get('title')) ?? '',
    artist: toStr(record.get('artist')),
    pressingYear: toInt(record.get('pressingYear')),
    format: toStr(record.get('format')),
    thumbUrl: toStr(record.get('thumbUrl')),
  };
}

// ---------------------------------------------------------------------------
// getReleasesByMusician
// ---------------------------------------------------------------------------

export async function getReleasesByMusician(
  driver: Driver,
  name: string,
): Promise<MusicianRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c:CREDITED_ON]->(r:Release)
      WHERE toLower(m.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl,
             c.displayRole AS instrument, c.roleCategory AS role
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map((rec) => ({
      ...mapExploreRelease(rec),
      instrument: toStr(rec.get('instrument')),
      role: toStr(rec.get('role')),
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByStudio
// ---------------------------------------------------------------------------

export async function getReleasesByStudio(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:RECORDED_AT]->(s:Studio)
      WHERE toLower(s.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByLabel
// ---------------------------------------------------------------------------

export async function getReleasesByLabel(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:ON_LABEL]->(l:Label)
      WHERE toLower(l.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByGenre
// ---------------------------------------------------------------------------

export async function getReleasesByGenre(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:IN_GENRE]->(g:Genre)
      WHERE toLower(g.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByStyle
// ---------------------------------------------------------------------------

export async function getReleasesByStyle(driver: Driver, name: string): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:IN_STYLE]->(s:Style)
      WHERE toLower(s.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByCountry
// ---------------------------------------------------------------------------

export async function getReleasesByCountry(
  driver: Driver,
  name: string,
): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:FROM_COUNTRY]->(c:Country)
      WHERE toLower(c.name) = toLower($name)
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { name },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByDecade
// ---------------------------------------------------------------------------

export async function getReleasesByDecade(
  driver: Driver,
  decade: string,
): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)-[:RECORDED_IN_DECADE]->(d:Decade)
      WHERE d.name = $decade
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY pressingYear
      `,
      { decade },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getReleasesByYear
// ---------------------------------------------------------------------------

export async function getReleasesByYear(driver: Driver, year: number): Promise<ExploreRelease[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (r:Release)
      WHERE coalesce(r.originalYear, r.pressingYear) = $year
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
      RETURN r.discogsId AS discogsId, r.title AS title, a.name AS artist,
             coalesce(r.originalYear, r.pressingYear) AS pressingYear,
             r.format AS format, r.thumbUrl AS thumbUrl
      ORDER BY r.title
      `,
      { year: neo4j.int(year) },
    );
    return result.records.map(mapExploreRelease);
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getConnections
// Depth is a validated literal (1 | 2 | 3) — safe to interpolate into Cypher.
// ---------------------------------------------------------------------------

export async function getConnections(
  driver: Driver,
  discogsId: number,
  depth: 1 | 2 | 3,
): Promise<ConnectionsResult | null> {
  const session = driver.session();
  try {
    const query = `
      MATCH (start:Release {discogsId: $discogsId})
      OPTIONAL MATCH (r)-[:RELEASED_BY]->(sa:Artist)
        WHERE r = start
      OPTIONAL MATCH (start)-[*1..${depth}]-(connected)
        WHERE (connected:Release OR connected:Artist OR connected:Musician OR connected:Studio)
          AND connected <> start
      WITH start, sa,
           collect(DISTINCT {
             type: head(labels(connected)),
             discogsId: connected.discogsId,
             name: connected.name,
             title: connected.title
           })[..200] AS nodes
      RETURN start.discogsId AS discogsId, start.title AS title, sa.name AS artist,
             coalesce(start.originalYear, start.pressingYear) AS pressingYear,
             start.format AS format, start.thumbUrl AS thumbUrl,
             nodes
    `;
    const result = await session.run(query, { discogsId: neo4j.int(discogsId) });
    if (result.records.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rec = result.records[0]!;
    const seed: ExploreRelease = {
      discogsId: toInt(rec.get('discogsId')) ?? 0,
      title: toStr(rec.get('title')) ?? '',
      artist: toStr(rec.get('artist')),
      pressingYear: toInt(rec.get('pressingYear')),
      format: toStr(rec.get('format')),
      thumbUrl: toStr(rec.get('thumbUrl')),
    };
    const rawNodes = rec.get('nodes') as Array<{
      type: unknown;
      discogsId: unknown;
      name: unknown;
      title: unknown;
    }>;
    const nodes: ConnectionNode[] = rawNodes
      .filter((n) => n.type !== null)
      .map((n) => ({
        type: toStr(n.type) ?? '',
        discogsId: toInt(n.discogsId),
        name: toStr(n.name),
        title: toStr(n.title),
      }));
    return { seed, nodes };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// getSharedMusicians
// ---------------------------------------------------------------------------

export async function getSharedMusicians(driver: Driver): Promise<SharedMusiciansResult[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (m:Musician)-[c1:CREDITED_ON]->(r1:Release),
            (m)-[:CREDITED_ON]->(r2:Release)
      WHERE r1.discogsId < r2.discogsId
      WITH r1, r2, collect(DISTINCT {name: m.name, instrument: c1.displayRole}) AS sharedMusicians
      WHERE size(sharedMusicians) > 0
      RETURN r1.discogsId AS releaseAId, r1.title AS releaseATitle,
             r2.discogsId AS releaseBId, r2.title AS releaseBTitle,
             sharedMusicians
      LIMIT 200
      `,
    );
    return result.records.map((rec) => {
      const rawMusicians = rec.get('sharedMusicians') as Array<{
        name: unknown;
        instrument: unknown;
      }>;
      return {
        releaseA: {
          discogsId: toInt(rec.get('releaseAId')) ?? 0,
          title: toStr(rec.get('releaseATitle')) ?? '',
        },
        releaseB: {
          discogsId: toInt(rec.get('releaseBId')) ?? 0,
          title: toStr(rec.get('releaseBTitle')) ?? '',
        },
        sharedMusicians: rawMusicians.map((m) => ({
          name: toStr(m.name) ?? '',
          instrument: toStr(m.instrument),
        })),
      };
    });
  } finally {
    await session.close();
  }
}
