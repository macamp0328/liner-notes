import type { Logger } from './discogs-client.js';

export interface WikidataClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every request (successful or skipped). Keep at or below 1 req/sec. */
  delayMs: number;
  /** Initial backoff ms on 429/502/503 retries. Defaults to 2000ms. Set to 0 in tests. */
  backoffBaseMs?: number;
  logger?: Logger;
}

interface SparqlResponse {
  results: {
    bindings: Array<Record<string, { type: string; value: string } | undefined>>;
  };
}

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const MAX_RETRIES = 3;

const DEFAULT_BACKOFF_BASE_MS = 2_000;

export class WikidataClient {
  private readonly userAgent: string;
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  constructor(config: WikidataClientConfig) {
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
  }

  /**
   * Look up an artist's ISO 3166-1 alpha-2 country of citizenship by Discogs artist ID.
   * Uses Wikidata property P1953 (Discogs artist ID) → P27 (country of citizenship) → P297 (ISO code).
   * Returns null when the artist is not in Wikidata or has no country of citizenship set.
   *
   * Retries on 429, 503, 502 (transient Bad Gateway from Blazegraph), and text/html responses
   * (Wikidata sometimes serves HTML maintenance pages with a 200 OK) with exponential backoff.
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
    return this.executeSparql(query, `discogsId=${discogsId}`);
  }

  /**
   * Look up an artist's country by their English Wikipedia article title.
   * Uses Wikidata's schema:about triple to find the Wikidata item for the Wikipedia article,
   * then resolves P27 (country of citizenship) → P297 (ISO 3166-1 alpha-2 code).
   *
   * This covers artists who have a Wikipedia page but whose Discogs ID (P1953) isn't in Wikidata.
   */
  async getCountryByWikipediaTitle(articleTitle: string): Promise<string | null> {
    const encodedTitle = encodeURIComponent(articleTitle.replace(/ /g, '_'));
    const query = `
      SELECT ?countryCode WHERE {
        ?item schema:about <https://en.wikipedia.org/wiki/${encodedTitle}> .
        ?item wdt:P27 ?country .
        ?country wdt:P297 ?countryCode .
      }
      LIMIT 1
    `;
    return this.executeSparql(query, `wikipedia="${articleTitle}"`);
  }

  /**
   * Look up the country for an English Wikipedia URL by embedding the raw URL path
   * segment directly into the SPARQL IRI — no decode/re-encode round-trip.
   * Non-English Wikipedia URLs return null without making a network call.
   */
  async getCountryByWikipediaUrl(url: string): Promise<string | null> {
    const match = /^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/.exec(url);
    if (!match?.[1]) return null;
    const rawPath = match[1];
    const query = `
      SELECT ?countryCode WHERE {
        ?item schema:about <https://en.wikipedia.org/wiki/${rawPath}> .
        ?item wdt:P27 ?country .
        ?country wdt:P297 ?countryCode .
      }
      LIMIT 1
    `;
    return this.executeSparql(query, `wikipedia-url="${url}"`);
  }

  private async executeSparql(query: string, logLabel: string): Promise<string | null> {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;

    let attempt = 0;
    let backoffMs = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/sparql-results+json',
          },
        });

        if (response.status === 429 || response.status === 503 || response.status === 502) {
          if (attempt >= MAX_RETRIES) break;
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
          const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
          const waitMs = Math.max(backoffMs, retryAfterMs);
          this.log.warn(
            `[wikidata-client] HTTP ${response.status} for ${logLabel} on attempt ${attempt + 1}/${MAX_RETRIES + 1} — retrying in ${waitMs}ms`,
          );
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, 32_000);
          attempt++;
          continue;
        }

        if (!response.ok) {
          this.log.warn(`[wikidata-client] HTTP ${response.status} for ${logLabel} — skipping`);
          return null;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/html')) {
          if (attempt >= MAX_RETRIES) break;
          this.log.warn(
            `[wikidata-client] HTML response (status ${response.status}) for ${logLabel} on attempt ${attempt + 1}/${MAX_RETRIES + 1} — retrying in ${backoffMs}ms`,
          );
          await this.sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 32_000);
          attempt++;
          continue;
        }

        const data = (await response.json()) as SparqlResponse;
        await this.sleep(this.delayMs);

        const binding = data.results.bindings[0];
        const code = binding?.['countryCode']?.value?.trim();
        return code ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`[wikidata-client] Network error for ${logLabel} — ${msg}`);
        return null;
      }
    }

    this.log.warn(`[wikidata-client] Exceeded max retries for ${logLabel} — skipping`);
    return null;
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
