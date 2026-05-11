import { Driver } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type SearchResultItem =
  | { type: 'Artist'; name: string; discogsId: number; score: number }
  | {
      type: 'Release';
      title: string;
      discogsId: number;
      artist: string | null;
      score: number;
    }
  | {
      type: 'Track';
      title: string;
      releaseTitle: string | null;
      releaseDiscogsId: number | null;
      score: number;
    };

export interface LyricsSearchResult {
  trackTitle: string;
  releaseTitle: string | null;
  releaseDiscogsId: number | null;
  score: number;
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

function toFloat(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && val !== null && 'toNumber' in val) {
    return (val as { toNumber: () => number }).toNumber();
  }
  return Number(val) || 0;
}

// ---------------------------------------------------------------------------
// searchGeneral
// ---------------------------------------------------------------------------

export async function searchGeneral(driver: Driver, q: string): Promise<SearchResultItem[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      CALL db.index.fulltext.queryNodes("releaseArtistTrackSearch", $q) YIELD node, score
      WITH node, score, labels(node) AS nodeLabels
      OPTIONAL MATCH (node)<-[:HAS_TRACK]-(trackRelease:Release)
      OPTIONAL MATCH (artistRelease:Release)-[:RELEASED_BY]->(node)
        WHERE 'Artist' IN labels(node)
      RETURN nodeLabels, node, score,
             trackRelease.title AS trackReleaseTitle,
             trackRelease.discogsId AS trackReleaseDiscogsId,
             artistRelease.title AS artistReleaseTitle
      ORDER BY score DESC
      LIMIT 50
      `,
      { q },
    );

    return result.records.flatMap((rec): SearchResultItem[] => {
      const nodeLabels = rec.get('nodeLabels') as string[];
      const node = rec.get('node') as Record<string, unknown> & {
        properties: Record<string, unknown>;
      };
      const score = toFloat(rec.get('score'));
      const props = node.properties;

      if (nodeLabels.includes('Artist')) {
        return [
          {
            type: 'Artist',
            name: toStr(props['name']) ?? '',
            discogsId: toInt(props['discogsId']) ?? 0,
            score,
          },
        ];
      }

      if (nodeLabels.includes('Release')) {
        return [
          {
            type: 'Release',
            title: toStr(props['title']) ?? '',
            discogsId: toInt(props['discogsId']) ?? 0,
            artist: toStr(rec.get('artistReleaseTitle')),
            score,
          },
        ];
      }

      if (nodeLabels.includes('Track')) {
        return [
          {
            type: 'Track',
            title: toStr(props['title']) ?? '',
            releaseTitle: toStr(rec.get('trackReleaseTitle')),
            releaseDiscogsId: toInt(rec.get('trackReleaseDiscogsId')),
            score,
          },
        ];
      }

      return [];
    });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// searchLyrics
// ---------------------------------------------------------------------------

export async function searchLyrics(driver: Driver, q: string): Promise<LyricsSearchResult[]> {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      CALL db.index.fulltext.queryNodes("lyricsSearch", $q) YIELD node, score
      OPTIONAL MATCH (r:Release)-[:HAS_TRACK]->(node)
      RETURN node.title AS trackTitle, r.title AS releaseTitle,
             r.discogsId AS releaseDiscogsId, score
      ORDER BY score DESC
      LIMIT 50
      `,
      { q },
    );

    return result.records.map((rec) => ({
      trackTitle: toStr(rec.get('trackTitle')) ?? '',
      releaseTitle: toStr(rec.get('releaseTitle')),
      releaseDiscogsId: toInt(rec.get('releaseDiscogsId')),
      score: toFloat(rec.get('score')),
    }));
  } finally {
    await session.close();
  }
}
