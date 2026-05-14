import type { Logger } from './discogs-client.js';

export interface WikidataClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every request. Keep at or below 1 req/sec. */
  delayMs: number;
  logger?: Logger;
}

interface SparqlResponse {
  results: {
    bindings: Array<Record<string, { type: string; value: string } | undefined>>;
  };
}

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

export class WikidataClient {
  private readonly userAgent: string;
  private readonly delayMs: number;
  private readonly log: Logger;

  constructor(config: WikidataClientConfig) {
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.log = config.logger ?? console;
  }

  /**
   * Look up an artist's ISO 3166-1 alpha-2 country of citizenship by Discogs artist ID.
   * Uses Wikidata property P1953 (Discogs artist ID) → P27 (country of citizenship) → P297 (ISO code).
   * Returns null when the artist is not in Wikidata or has no country of citizenship set.
   */
  async getCountryByDiscogsId(discogsId: number): Promise<string | null> {
    // P1953 = Discogs artist ID, P27 = country of citizenship, P297 = ISO 3166-1 alpha-2 code
    const query = `
      SELECT ?countryCode WHERE {
        ?item wdt:P1953 "${discogsId}" .
        ?item wdt:P27 ?country .
        ?country wdt:P297 ?countryCode .
      }
      LIMIT 1
    `;

    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/sparql-results+json',
        },
      });

      if (response.status === 429 || response.status === 503) {
        this.log.warn(
          `[wikidata-client] Rate limited (${response.status}) for discogsId=${discogsId} — skipping`,
        );
        await this.sleep(this.delayMs);
        return null;
      }

      if (!response.ok) {
        this.log.warn(
          `[wikidata-client] HTTP ${response.status} for discogsId=${discogsId} — skipping`,
        );
        await this.sleep(this.delayMs);
        return null;
      }

      const data = (await response.json()) as SparqlResponse;
      await this.sleep(this.delayMs);

      const binding = data.results.bindings[0];
      const code = binding?.['countryCode']?.value?.trim();
      return code ?? null;
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function buildWikidataClientFromEnv(logger?: Logger): WikidataClient | null {
  const userAgent = process.env['MUSICBRAINZ_USER_AGENT'] ?? process.env['DISCOGS_USER_AGENT'];
  if (!userAgent) return null;
  return new WikidataClient({
    userAgent,
    delayMs: 1100,
    ...(logger !== undefined ? { logger } : {}),
  });
}
