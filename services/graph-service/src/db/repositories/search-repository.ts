import { Driver } from 'neo4j-driver';
import { toInt, toStr, toFloat } from '../coercions.js';
import { escapeLuceneQuery } from '../lucene.js';

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
// searchGeneral
// ---------------------------------------------------------------------------

export async function searchGeneral(driver: Driver, q: string): Promise<SearchResultItem[]> {
  const escaped = escapeLuceneQuery(q);
  if (escaped.trim().length === 0) {
    return [];
  }
  const session = driver.session();
  try {
    const result = await session.run(
      `
      CALL db.index.fulltext.queryNodes("releaseArtistTrackSearch", $q) YIELD node, score
      WITH node, score, labels(node) AS nodeLabels
      OPTIONAL MATCH (node)<-[:HAS_TRACK]-(trackRelease:Release)
        WHERE 'Track' IN labels(node)
      OPTIONAL MATCH (node)-[:RELEASED_BY]->(releaseArtist:Artist)
        WHERE 'Release' IN labels(node)
      RETURN nodeLabels, node, score,
             trackRelease.title AS trackReleaseTitle,
             trackRelease.discogsId AS trackReleaseDiscogsId,
             releaseArtist.name AS releaseArtistName
      ORDER BY score DESC
      LIMIT 50
`,
      { q: escaped },
    );

    return result.records.flatMap((rec): SearchResultItem[] => {
      const nodeLabels = rec.get('nodeLabels') as string[];
      const node = rec.get('node') as Record<string, unknown> & {
        properties: Record<string, unknown>;
      };
      // Fulltext queryNodes always yields a score; ?? 0 keeps the contract number (never null).
      const score = toFloat(rec.get('score')) ?? 0;
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
            artist: toStr(rec.get('releaseArtistName')),
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
  const escaped = escapeLuceneQuery(q);
  if (escaped.trim().length === 0) {
    return [];
  }
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
      { q: escaped },
    );

    return result.records.map((rec) => ({
      trackTitle: toStr(rec.get('trackTitle')) ?? '',
      releaseTitle: toStr(rec.get('releaseTitle')),
      releaseDiscogsId: toInt(rec.get('releaseDiscogsId')),
      score: toFloat(rec.get('score')) ?? 0,
    }));
  } finally {
    await session.close();
  }
}
