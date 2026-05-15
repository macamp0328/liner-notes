import type { Logger } from './discogs-client.js';

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
const MARC_TO_ISO = new Map<string, string>([
  ['xxu', 'US'],
  ['xxk', 'GB'],
  ['fr', 'FR'],
  ['gw', 'DE'],
  ['it', 'IT'],
  ['be', 'BE'],
  ['ne', 'NL'],
  ['sw', 'SE'],
  ['au', 'AU'],
  ['ja', 'JP'],
  ['ca', 'CA'],
  ['ng', 'NG'],
  ['sa', 'SN'],
  ['sp', 'ES'],
  ['po', 'PT'],
  ['ru', 'RU'],
  ['pl', 'PL'],
  ['hu', 'HU'],
  ['cz', 'CZ'],
  ['fi', 'FI'],
  ['dk', 'DK'],
  ['no', 'NO'],
  ['ic', 'IS'],
  ['nz', 'NZ'],
  ['ua', 'UA'],
  ['gz', 'GR'],
  ['tu', 'TR'],
  ['is', 'IL'],
  ['cc', 'CO'],
  ['bl', 'BR'],
  ['ag', 'AR'],
  ['mx', 'MX'],
  ['ku', 'KR'],
  ['ch', 'CN'],
  ['ia', 'IN'],
  ['mj', 'MA'],
  ['ao', 'AO'],
  ['et', 'ET'],
  ['gh', 'GH'],
  ['sj', 'ZA'],
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

export class VIAFClient {
  private readonly userAgent: string;
  private readonly delayMs: number;
  private readonly backoffBaseMs: number;
  private readonly log: Logger;

  constructor(config: VIAFClientConfig) {
    this.userAgent = config.userAgent;
    this.delayMs = config.delayMs;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.log = config.logger ?? console;
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
   * Retries on 429 and 503 with exponential backoff.
   */
  async getCountryByName(name: string): Promise<string | null> {
    const encodedName = encodeURIComponent(`"${name}"`);
    const url = `${VIAF_SEARCH}?query=local.names+all+${encodedName}&maximumRecords=5&httpAccept=application/json`;

    let attempt = 0;
    let backoffMs = this.backoffBaseMs;

    while (attempt <= MAX_RETRIES) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': this.userAgent },
        });

        if (response.status === 429 || response.status === 503) {
          if (attempt >= MAX_RETRIES) break;
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryAfterRaw = parseInt(retryAfterHeader ?? '', 10);
          const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1_000 : 0;
          const waitMs = Math.max(backoffMs, retryAfterMs);
          this.log.warn(
            `[viaf-client] HTTP ${response.status} for "${name}" on attempt ${attempt + 1}/${MAX_RETRIES + 1} — retrying in ${waitMs}ms`,
          );
          await this.sleep(waitMs);
          backoffMs = Math.min(backoffMs * 2, 32_000);
          attempt++;
          continue;
        }

        if (!response.ok) {
          this.log.warn(`[viaf-client] HTTP ${response.status} for "${name}" — skipping`);
          return null;
        }

        const data = (await response.json()) as ViafSearchResponse;
        await this.sleep(this.delayMs);

        return this.extractCountry(name, data);
      } catch {
        return null;
      }
    }

    this.log.warn(`[viaf-client] Exceeded max retries for "${name}" — skipping`);
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
