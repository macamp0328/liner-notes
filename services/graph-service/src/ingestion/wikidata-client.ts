import { transientNetworkCode } from './network-errors.js';
import { normalizeInstrumentFamilies } from './transforms.js';
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
import { DEFAULT_OUTBOUND_TIMEOUT_MS, resolveOutboundTimeoutMs } from './outbound-timeout.js';

export interface WikidataClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every request (successful or skipped). Keep at or below 1 req/sec. */
  delayMs: number;
  /** Initial backoff ms on 429/502/503 retries. Defaults to 2000ms. Set to 0 in tests. */
  backoffBaseMs?: number;
  /** Per-request timeout in ms (#357). Falls back to the shared fetch default when omitted. */
  timeoutMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  logger?: Logger;
  /** Disable the per-source circuit breaker (#242); on by default. */
  disableCircuitBreaker?: boolean;
}

type SparqlBinding = Record<string, { type: string; value: string } | undefined>;

interface SparqlResponse {
  results: {
    bindings: SparqlBinding[];
  };
}

/**
 * Structured biographical data harvested from a single Wikidata item (#341). All fields are
 * best-effort: a clean P1953 (or Wikipedia-URL) match resolves the `qid`, and every other field
 * is whatever that item happens to assert. `bornYear`/`diedYear` are always reliable (the year is
 * trustworthy at any Wikidata date precision); `bornDate`/`diedDate` are populated ONLY at day
 * precision, because Wikidata truncates a year/month-precision date to `YYYY-01-01` / `YYYY-MM-01`,
 * which would masquerade as a real day. `awards` is `[]` (not null) when the item lists none.
 *
 * `playsInstrument`/`playsInstrumentRaw` are the person-level instrument axis from P1303 (#393),
 * the companion to the per-credit CREDITED_ON.instrument axis (#333): `playsInstrumentRaw` keeps the
 * verbatim English labels, `playsInstrument` is those normalized onto the #333 family vocabulary
 * (deduped, sorted). Both are `[]` (not null) when the item lists no instruments.
 *
 * `influencedByQids` is the bare list of Wikidata QIDs this item asserts as influences via P737
 * ("influenced by"), #391. We keep the QIDs (not labels) because the `artist-influences` pass resolves
 * each one against the stored `Artist.wikidataQid` to write an in-collection `INFLUENCED_BY` edge —
 * a deterministic QID join, never a name match. `[]` (not null) when the item lists no influences.
 */
export interface ArtistWikidataData {
  qid: string;
  bornYear: number | null;
  bornDate: string | null;
  diedYear: number | null;
  diedDate: string | null;
  imageUrl: string | null;
  awards: string[];
  playsInstrument: string[];
  playsInstrumentRaw: string[];
  influencedByQids: string[];
}

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const MAX_RETRIES = 3;

const DEFAULT_BACKOFF_BASE_MS = 2_000;

// Wikidata `wikibase:timePrecision`: 11 = day, 10 = month, 9 = year. Below day, the truncated
// value is not a real calendar day — see ArtistWikidataData.
const TIME_PRECISION_DAY = 11;

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
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
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

  /**
   * Resolve an artist's full Wikidata biographical bundle by Discogs artist ID (#341).
   * Joins deterministically on P1953 → the QID, then harvests P569/P570 (lifespan), P18 (image),
   * P166 (awards, English labels), and P1303 (instruments played, English labels, #393) in one
   * query. Returns null when the Discogs ID is not in Wikidata. Same soft-skip-to-null and retry
   * semantics as the country lookups.
   */
  async getArtistDataByDiscogsId(discogsId: number): Promise<ArtistWikidataData | null> {
    const query = this.buildArtistDataQuery(`?item wdt:P1953 "${discogsId}" .`);
    const row = await this.fetchFirstRow(query, `artist-data discogsId=${discogsId}`);
    return row ? parseArtistWikidataRow(row) : null;
  }

  /**
   * Resolve an artist's Wikidata bundle by their English Wikipedia URL — the fallback for artists
   * whose Discogs ID (P1953) is not in Wikidata but who have a Wikipedia article (mirrors the
   * nationality fallback). The raw URL path is embedded directly into the SPARQL IRI; non-English
   * Wikipedia URLs return null without a network call.
   */
  async getArtistDataByWikipediaUrl(url: string): Promise<ArtistWikidataData | null> {
    const match = /^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/.exec(url);
    if (!match?.[1]) return null;
    const query = this.buildArtistDataQuery(
      `?item schema:about <https://en.wikipedia.org/wiki/${match[1]}> .`,
    );
    const row = await this.fetchFirstRow(query, `artist-data wikipedia-url="${url}"`);
    return row ? parseArtistWikidataRow(row) : null;
  }

  /**
   * Build the artist-data SPARQL, parameterized only by the line that binds `?item` (P1953 match
   * or a Wikipedia `schema:about` IRI). Dates go through `p:`/`psv:` so the `timePrecision`
   * qualifier comes back paired with its value (both in GROUP BY, so they stay from the same
   * statement). `?image` is `SAMPLE`d and kept OUT of GROUP BY: an item with several P18 images
   * must NOT fan out into one row per image, or the `GROUP_CONCAT` awards would be split across
   * those rows and `LIMIT 1` would silently truncate the awards list (and pick an arbitrary image).
   * With only `?item`/dates grouped, every award cross-joins into the single (common-case) row, so
   * the concat is complete. The `LANG="en"` filter is inside the P166 OPTIONAL so an unlabelled
   * award never blanks the row. P1303 (instruments, #393) is fetched the same way: a second
   * `GROUP_CONCAT(DISTINCT …)` over the same grouping. Two multi-valued OPTIONALs make the awards ×
   * instruments cross-product larger, but `DISTINCT` collapses each concat independently per column,
   * so neither corrupts the other and both come back complete (the count is bounded and tiny per
   * person). P737 (influences, #391) is fetched the same way — a third `GROUP_CONCAT(DISTINCT …)`,
   * but over the raw `?influencer` entity IRI (no `rdfs:label` join): the `artist-influences` pass
   * resolves each by QID, not by name. Three multi-valued OPTIONALs make the cross-product larger
   * still, yet the per-column `DISTINCT` keeps each concat independent and complete. Wikidata's SPARQL
   * endpoint pre-declares every prefix used here.
   */
  private buildArtistDataQuery(subjectLine: string): string {
    return `
      SELECT ?item ?birth ?birthPrecision ?death ?deathPrecision (SAMPLE(?img) AS ?image)
             (GROUP_CONCAT(DISTINCT ?awardLabel; SEPARATOR="||") AS ?awards)
             (GROUP_CONCAT(DISTINCT ?instrLabel; SEPARATOR="||") AS ?instruments)
             (GROUP_CONCAT(DISTINCT ?influencer; SEPARATOR="||") AS ?influencers) WHERE {
        ${subjectLine}
        OPTIONAL { ?item p:P569/psv:P569 [ wikibase:timeValue ?birth ; wikibase:timePrecision ?birthPrecision ] . }
        OPTIONAL { ?item p:P570/psv:P570 [ wikibase:timeValue ?death ; wikibase:timePrecision ?deathPrecision ] . }
        OPTIONAL { ?item wdt:P18 ?img . }
        OPTIONAL { ?item wdt:P166 ?award . ?award rdfs:label ?awardLabel . FILTER(LANG(?awardLabel) = "en") }
        OPTIONAL { ?item wdt:P1303 ?instr . ?instr rdfs:label ?instrLabel . FILTER(LANG(?instrLabel) = "en") }
        OPTIONAL { ?item wdt:P737 ?influencer . }
      }
      GROUP BY ?item ?birth ?birthPrecision ?death ?deathPrecision
      LIMIT 1
    `;
  }

  private async executeSparql(query: string, logLabel: string): Promise<string | null> {
    const row = await this.fetchFirstRow(query, logLabel);
    return row?.['countryCode']?.value?.trim() ?? null;
  }

  /**
   * Run a SPARQL query and return its first result binding (or null on no rows / any failure).
   * Unlike the other clients, Wikidata never throws — every failure soft-skips to null. The
   * shared core throws on exhaustion (RetriesExhaustedError) or rethrows a transient network
   * error that outlived its retry budget; both mean "give up on this lookup", so we catch and
   * return null. A one-shot non-transient error (the core rethrows it immediately) is a
   * plain network-error skip.
   */
  private async fetchFirstRow(query: string, logLabel: string): Promise<SparqlBinding | null> {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;

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
      return data.results.bindings[0] ?? null;
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

/** Extract the bare QID (`Q1299`) from a Wikidata entity IRI. */
function extractQid(itemIri: string | undefined): string | null {
  if (!itemIri) return null;
  const match = /\/(Q\d+)$/.exec(itemIri);
  return match?.[1] ?? null;
}

/** Year from an `xsd:dateTime` like `1941-10-13T00:00:00Z` — reliable at any Wikidata precision. */
function parseWikidataYear(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?\d+)-\d{2}-\d{2}T/.exec(value);
  if (!match?.[1]) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

function parsePrecision(value: string | undefined): number | null {
  if (!value) return null;
  const precision = Number.parseInt(value, 10);
  return Number.isFinite(precision) ? precision : null;
}

/** Full `YYYY-MM-DD` date string ONLY at day precision; null otherwise (see ArtistWikidataData). */
function parseWikidataDate(value: string | undefined, precision: number | null): string | null {
  if (!value || precision === null || precision < TIME_PRECISION_DAY) return null;
  const datePart = value.split('T')[0];
  return datePart && datePart.length > 0 ? datePart : null;
}

/** Split a `||`-joined GROUP_CONCAT binding (awards, instruments, …) into trimmed, non-empty labels. */
function parseConcatLabels(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('||')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

/**
 * Split a `||`-joined GROUP_CONCAT of Wikidata entity IRIs (P737 influences, #391) into bare QIDs,
 * dropping any segment that isn't a resolvable `Q\d+` IRI. `[]` when the binding is absent/empty.
 */
function parseConcatQids(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('||')
    .map((iri) => extractQid(iri.trim()))
    .filter((qid): qid is string => qid !== null);
}

/**
 * Map a SPARQL result row from {@link WikidataClient.buildArtistDataQuery} onto
 * {@link ArtistWikidataData}. Returns null when the row carries no resolvable QID (the join key) —
 * the bundle is meaningless without it.
 */
export function parseArtistWikidataRow(row: SparqlBinding): ArtistWikidataData | null {
  const qid = extractQid(row['item']?.value);
  if (qid === null) return null;
  const birthValue = row['birth']?.value;
  const deathValue = row['death']?.value;
  const image = row['image']?.value?.trim();
  const playsInstrumentRaw = parseConcatLabels(row['instruments']?.value);
  return {
    qid,
    bornYear: parseWikidataYear(birthValue),
    bornDate: parseWikidataDate(birthValue, parsePrecision(row['birthPrecision']?.value)),
    diedYear: parseWikidataYear(deathValue),
    diedDate: parseWikidataDate(deathValue, parsePrecision(row['deathPrecision']?.value)),
    imageUrl: image && image.length > 0 ? image : null,
    awards: parseConcatLabels(row['awards']?.value),
    playsInstrument: normalizeInstrumentFamilies(playsInstrumentRaw),
    playsInstrumentRaw,
    influencedByQids: parseConcatQids(row['influencers']?.value),
  };
}

export function buildWikidataClientFromEnv(logger?: Logger): WikidataClient | null {
  const userAgent = process.env['MUSICBRAINZ_USER_AGENT'] ?? process.env['DISCOGS_USER_AGENT'];
  if (!userAgent) return null;
  return new WikidataClient({
    userAgent,
    delayMs: 1100,
    timeoutMs: resolveOutboundTimeoutMs(DEFAULT_OUTBOUND_TIMEOUT_MS),
    ...(logger !== undefined ? { logger } : {}),
  });
}
