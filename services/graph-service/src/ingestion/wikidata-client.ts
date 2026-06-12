import { transientNetworkCode } from './network-errors.js';
import {
  createRateLimitedFetch,
  RetriesExhaustedError,
  type Logger,
  type RateLimitedFetch,
} from './rate-limited-fetch.js';
import {
  buildCircuitBreaker,
  closedSnapshot,
  CircuitBreakerOpenError,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';

export interface WikidataClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every request (successful or skipped). Keep at or below 1 req/sec. */
  delayMs: number;
  /** Initial backoff ms on 429/502/503 retries. Defaults to 2000ms. Set to 0 in tests. */
  backoffBaseMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  logger?: Logger;
  /** Disable the per-source circuit breaker (#242); on by default. */
  disableCircuitBreaker?: boolean;
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
  private readonly log: Logger;
  private readonly rlFetch: RateLimitedFetch;
  private readonly breaker: CircuitBreaker | undefined;

  constructor(config: WikidataClientConfig) {
    this.userAgent = config.userAgent;
    this.log = config.logger ?? console;
    this.breaker =
      config.disableCircuitBreaker === true
        ? undefined
        : buildCircuitBreaker('wikidata', config.logger);
    this.rlFetch = createRateLimitedFetch({
      label: 'wikidata-client',
      apiName: 'Wikidata API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      // 502 = transient Bad Gateway from Blazegraph.
      retryStatuses: [429, 502, 503],
      // Wikidata sometimes serves an HTML maintenance page with a 200 OK — retry those
      // (only when ok; an HTML error page must still soft-skip via the !ok branch below).
      shouldRetryResponse: (res) =>
        res.ok && (res.headers.get('content-type') ?? '').includes('text/html')
          ? 'HTML response'
          : null,
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
      ...(this.breaker !== undefined ? { breaker: this.breaker } : {}),
    });
  }

  /** Current circuit-breaker state for run-summary surfacing; closed when the breaker is off. */
  breakerSnapshot(): CircuitBreakerSnapshot {
    return this.breaker?.snapshot() ?? closedSnapshot('wikidata');
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

    // Unlike the other clients, Wikidata never throws — every failure soft-skips to null. The
    // shared core throws on exhaustion (RetriesExhaustedError) or rethrows a transient network
    // error that outlived its retry budget; both mean "give up on this lookup", so we catch and
    // return null. A one-shot non-transient error (the core rethrows it immediately) is a
    // plain network-error skip.
    try {
      const response = await this.rlFetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/sparql-results+json',
        },
      });

      if (!response.ok) {
        this.log.warn(`[wikidata-client] HTTP ${response.status} for ${logLabel} — skipping`);
        return null;
      }

      const data = (await response.json()) as SparqlResponse;
      const binding = data.results.bindings[0];
      const code = binding?.['countryCode']?.value?.trim();
      return code ?? null;
    } catch (err) {
      // An open breaker already logged its single trip line — short-circuit silently to null.
      if (err instanceof CircuitBreakerOpenError) return null;
      if (err instanceof RetriesExhaustedError || transientNetworkCode(err) !== null) {
        this.log.warn(`[wikidata-client] Exceeded max retries for ${logLabel} — skipping`);
        return null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`[wikidata-client] Network error for ${logLabel} — ${msg}`);
      return null;
    }
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
