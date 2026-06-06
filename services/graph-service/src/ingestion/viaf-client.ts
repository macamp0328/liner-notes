import type { Logger } from './discogs-client.js';
import { transientNetworkCode } from './network-errors.js';

export interface VIAFClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every request. Keep at or below 1 req/sec. */
  delayMs: number;
  /** Initial backoff ms on 429/503 retries. Defaults to 2000ms. Set to 0 in tests. */
  backoffBaseMs?: number;
  logger?: Logger;
}

// MARC 21 country codes → ISO 3166-1 alpha-2.
// VIAF returns codes with a trailing period (e.g. "fr.") — strip it before lookup.
// Source: https://www.loc.gov/marc/countries/cou_home.html
// IMPORTANT: several MARC codes are counterintuitive — comments note common mixups.
const MARC_TO_ISO = new Map<string, string>([
  ['xxu', 'US'], // United States
  ['xxk', 'GB'], // England / United Kingdom
  ['xxc', 'CA'], // Canada
  ['fr', 'FR'], // France
  ['gw', 'DE'], // Germany (was West Germany; VIAF uses gw for unified Germany)
  ['it', 'IT'], // Italy
  ['be', 'BE'], // Belgium
  ['ne', 'NL'], // Netherlands
  ['sw', 'SE'], // Sweden
  ['at', 'AU'], // Australia ('at' not 'au' — au = Austria)
  ['au', 'AT'], // Austria  ('au' not 'at' — at = Australia)
  ['ja', 'JP'], // Japan
  ['ng', 'NG'], // Nigeria
  ['sa', 'ZA'], // South Africa
  ['sp', 'ES'], // Spain
  ['po', 'PT'], // Portugal
  ['ru', 'RU'], // Russia
  ['pl', 'PL'], // Poland
  ['hu', 'HU'], // Hungary
  ['cz', 'CZ'], // Czech Republic
  ['fi', 'FI'], // Finland
  ['dk', 'DK'], // Denmark
  ['no', 'NO'], // Norway
  ['ic', 'IS'], // Iceland
  ['nz', 'NZ'], // New Zealand
  ['tu', 'TR'], // Turkey
  ['is', 'IL'], // Israel
  ['bl', 'BR'], // Brazil
  ['ag', 'AR'], // Argentina
  ['mx', 'MX'], // Mexico
  ['ko', 'KR'], // Korea (South) ('ko' not 'ku' — ku = Kuwait)
  ['ku', 'KW'], // Kuwait
  ['cc', 'CN'], // China (PRC) ('cc' not 'ch' — ch = Taiwan)
  ['ch', 'TW'], // Taiwan (Republic of China)
  ['ck', 'CO'], // Colombia
  ['gr', 'GR'], // Greece ('gr' not 'gz' — gz = Gaza Strip, no stable ISO code)
  ['un', 'UA'], // Ukraine ('un' not 'ua' — ua = Egypt)
  ['ii', 'IN'], // India ('ii' not 'ia' — ia = Iran)
  ['ia', 'IR'], // Iran
  ['mj', 'MA'], // Morocco
  ['ao', 'AO'], // Angola
  ['et', 'ET'], // Ethiopia
  ['gh', 'GH'], // Ghana
]);

const VIAF_SEARCH = 'https://viaf.org/viaf/search';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;

interface ViafNationalityEntry {
  text?: string;
}

interface ViafRecordData {
  viafID?: string;
  nameType?: string;
  mainHeadings?: {
    data?: Array<{ text?: string }>;
  };
  nationalityOfEntity?: {
    data?: ViafNationalityEntry | ViafNationalityEntry[];
  };
}

interface ViafRecord {
  record?: {
    recordData?: ViafRecordData;
  };
}

interface ViafSearchResponse {
  searchRetrieveResponse?: {
    records?: ViafRecord | ViafRecord[];
  };
}

function normalizeRecords(raw: ViafRecord | ViafRecord[] | undefined): ViafRecord[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function normalizeNationalities(
  raw: ViafNationalityEntry | ViafNationalityEntry[] | undefined,
): ViafNationalityEntry[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function marcToIso(marcCode: string): string | null {
  const normalized = marcCode.replace(/[\s.]+$/, '').toLowerCase();
  return MARC_TO_ISO.get(normalized) ?? null;
}

/**
 * Per-run HTTP-outcome tally for VIAF, exposed so the nationality pipeline can report whether
 * VIAF is actually answering or just being bot-blocked (#194). Counters are per HTTP *attempt*
 * (a single `getCountryByName` call may retry, so it can bump `calls` more than once), and
 * every attempt lands in exactly one outcome bucket — so the invariant
 * `calls === ok + botBlocked + html + httpError + rateLimited + networkError` always holds.
 *
 * `ok` means "received HTTP 200 + parseable JSON", which is NOT the same as resolving a country
 * (`extractCountry` can still return null on a name/MARC/agreement mismatch). The gap between
 * `ok` and the pipeline's resolved-by-VIAF count is the "answers but never matches" signal;
 * a high `botBlocked`/`html` with `ok` near zero is the "bot-blocked everywhere" signal.
 */
export interface ViafMetrics {
  calls: number;
  ok: number;
  botBlocked: number;
  html: number;
  httpError: number;
  rateLimited: number;
  networkError: number;
}

export function createEmptyViafMetrics(): ViafMetrics {
  return { calls: 0, ok: 0, botBlocked: 0, html: 0, httpError: 0, rateLimited: 0, networkError: 0 };
}

export class VIAFClient {
  private readonly userAgent: string;
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;
  private readonly metrics: ViafMetrics = createEmptyViafMetrics();

  constructor(config: VIAFClientConfig) {
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
  }

  /** Snapshot of this client's HTTP-outcome tally. See {@link ViafMetrics}. */
  getMetrics(): ViafMetrics {
    return { ...this.metrics };
  }

  /**
   * Look up an artist's ISO 3166-1 alpha-2 country by name via VIAF authority records.
   *
   * Guards against false positives:
   * - nameType must be "Personal" (excludes orchestras and corporate bodies)
   * - The result's preferred name must exactly match (case-insensitive) the queried name
   * - All nationality entries must resolve to the same ISO code; disagreement → null
   * - MARC codes not in the mapping table → null
   *
   * Sends `Accept: application/json` so VIAF's SRU endpoint returns JSON rather than its
   * HTML results page. Only 429 and 503 are retried (genuinely transient) with exponential
   * backoff. A 403 (VIAF's soft bot-block) and a 200 + text/html body are deterministic for a
   * given request, so they are hard-skipped — retrying the identical request cannot change the
   * outcome and only burns wall-clock. Every path that reaches VIAF's server is paced by
   * `delayMs` to stay within ~1 req/sec and avoid triggering more bot-blocks.
   */
  async getCountryByName(name: string): Promise<string | null> {
    // Escape CQL meta-characters that are meaningful inside a quoted phrase
    // (" and \ must be escaped; drop control characters that could break the query).
    const safeName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const encodedName = encodeURIComponent(`"${safeName}"`);
    const url = `${VIAF_SEARCH}?query=local.names+all+${encodedName}&maximumRecords=5&httpAccept=application/json`;

    let attempt = 0;
    let backoffMs = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      this.metrics.calls++;
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        });

        // 429/503 are genuinely transient — retry with exponential backoff.
        if (response.status === 429 || response.status === 503) {
          this.metrics.rateLimited++;
          if (attempt >= MAX_RETRIES) break;
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
          const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
          const waitMs = Math.max(backoffMs, retryAfterMs);
          this.log.warn(
            `[viaf-client] HTTP ${response.status} (rate limit/unavailable) for "${name}" on attempt ${attempt + 1}/${MAX_RETRIES + 1} — retrying in ${waitMs}ms`,
          );
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, 32_000);
          attempt++;
          continue;
        }

        // 403 is VIAF's soft bot-block — deterministic for this request, so don't retry.
        // Must be checked before the !response.ok guard (403 is also !ok) to keep this log.
        if (response.status === 403) {
          this.metrics.botBlocked++;
          this.log.warn(`[viaf-client] HTTP 403 (bot block) for "${name}" — skipping`);
          await this.sleep(this.delayMs);
          return null;
        }

        if (!response.ok) {
          this.metrics.httpError++;
          this.log.warn(`[viaf-client] HTTP ${response.status} for "${name}" — skipping`);
          await this.sleep(this.delayMs);
          return null;
        }

        // VIAF sometimes serves its HTML results page with a 200 OK. That is deterministic for
        // a given request, so skip rather than retry the identical call.
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        if (contentType.includes('text/html')) {
          this.metrics.html++;
          this.log.warn(
            `[viaf-client] HTML response (status ${response.status}) for "${name}" — skipping`,
          );
          await this.sleep(this.delayMs);
          return null;
        }

        const data = (await response.json()) as ViafSearchResponse;
        this.metrics.ok++;
        await this.sleep(this.delayMs);

        return this.extractCountry(name, data);
      } catch (err) {
        // A transient network-level failure (fetch failed / ECONNRESET / ...) is worth a
        // bounded retry on the same budget as the 429/503 branch above. Anything else stays a
        // soft-skip to null — this client never throws (see #189). Exhausting the retries
        // breaks to the "Exceeded max retries" path below, which also returns null.
        // Every catch entry — transient or not, and a 200-but-unparseable-JSON body — is one
        // failed attempt, so it counts as a single networkError.
        this.metrics.networkError++;
        const netCode = transientNetworkCode(err);
        if (netCode === null) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`[viaf-client] Network error for "${name}" — ${msg}`);
          return null;
        }
        if (attempt >= MAX_RETRIES) break;
        this.log.warn(
          `[viaf-client] Network error (${netCode}) for "${name}" on attempt ${attempt + 1}/${MAX_RETRIES + 1} — retrying in ${backoffMs}ms`,
        );
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 32_000);
        attempt++;
        continue;
      }
    }

    // Reached when 429/503 or transient-network retries are exhausted — HTML/403 return inline above.
    this.log.warn(`[viaf-client] Exceeded max retries for "${name}" — skipping`);
    await this.sleep(this.delayMs);
    return null;
  }

  private extractCountry(name: string, data: ViafSearchResponse): string | null {
    const records = normalizeRecords(data.searchRetrieveResponse?.records);
    const first = records[0]?.record?.recordData;
    if (!first) return null;

    if (first.nameType !== 'Personal') return null;

    // Confirm the preferred name matches to guard against common-name false positives.
    const preferredName = first.mainHeadings?.data?.[0]?.text ?? '';
    if (preferredName.toLowerCase() !== name.toLowerCase()) return null;

    const nationalities = normalizeNationalities(first.nationalityOfEntity?.data);
    if (nationalities.length === 0) return null;

    const isoCodes = new Set<string>();
    for (const entry of nationalities) {
      if (!entry.text) return null;
      const iso = marcToIso(entry.text);
      if (!iso) return null;
      isoCodes.add(iso);
    }

    // Disagreement between authority sources → return null rather than guess.
    if (isoCodes.size !== 1) return null;

    return [...isoCodes][0] ?? null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function buildViafClientFromEnv(logger?: Logger): VIAFClient | null {
  const userAgent = process.env['MUSICBRAINZ_USER_AGENT'];
  if (!userAgent) return null;
  return new VIAFClient({
    userAgent,
    delayMs: 1100,
    ...(logger !== undefined ? { logger } : {}),
  });
}
