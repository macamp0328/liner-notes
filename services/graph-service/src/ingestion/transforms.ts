// Pure data transformation functions for Discogs API responses.
// No I/O — all functions are deterministic and unit-testable.

import type {
  DiscogsCompany,
  DiscogsImage,
  DiscogsIdentifier,
  DiscogsTracklistEntry,
} from './types.js';

const INSTRUMENTAL_PATTERNS =
  /\b(instrumental|reprise|overture|intro|interlude|outro|theme|prelude|coda)\b/i;

/**
 * Parse a Discogs position string into a sortable (prefix, num) key.
 *
 * The prefix is the side/disc segment, the num is the trailing track number:
 * "A1" → {prefix:"A", num:1}; "B12" → {prefix:"B", num:12};
 * "2-3" → {prefix:"2-", num:3}; "5" → {prefix:"", num:5}; "A" → {prefix:"A", num:0}.
 *
 * Sorting by (prefix asc, num asc) with a numeric-aware collator reconstructs album
 * order: vinyl sides A<B<C<D, multi-disc CDs "1-"<"2-"<"10-", plain CDs share the empty
 * prefix. The numeric portion alone restarts at 1 on every vinyl side and is not
 * release-unique; prefix string comparison must be numeric-aware so disc 10 sorts after
 * disc 2, not before it.
 */
export function parsePosition(position: string): { prefix: string; num: number } {
  const numStr = /(\d+)$/.exec(position)?.[1];
  const num = numStr !== undefined ? parseInt(numStr, 10) : 0;
  const prefix =
    numStr !== undefined ? position.slice(0, position.length - numStr.length) : position;
  return { prefix, num };
}

/**
 * Extract the display role from a comma-delimited Discogs role string.
 * "Acoustic Guitar, Electric Guitar, Vocals" → "Acoustic Guitar"
 * "Technician [Studio Brain], Engineer [Assistant Engineer]" → "Technician [Studio Brain]"
 */
export function parseDisplayRole(role: string): string {
  const first = role.split(',')[0];
  return first !== undefined ? first.trim() : role;
}

export type RoleCategory =
  | 'performer'
  | 'composer'
  | 'producer'
  | 'engineer'
  | 'visual'
  | 'crew'
  | 'other';

const ROLE_CATEGORY_RULES: ReadonlyArray<readonly [RoleCategory, readonly string[]]> = [
  [
    'performer',
    [
      'guitar',
      'bass',
      'drums',
      'vocals',
      'piano',
      'saxophone',
      'trumpet',
      'violin',
      'cello',
      'flute',
      'keyboards',
      'synthesizer',
      'organ',
      'percussion',
      'tambourine',
      'harmonica',
      'banjo',
      'mandolin',
      'harp',
      'strings',
      'horns',
      'brass',
      'woodwind',
      'wind',
      'voice',
      'choir',
      'chimes',
      'bells',
      'shaker',
      'sampler',
      'handclaps',
      'clap',
      'sounds',
      'drone',
      'performer',
    ],
  ],
  [
    'composer',
    // 'orchestrat' matches 'orchestrator' / 'orchestrated by' — the orchestration end of the
    // arranging family (MB recording-level `orchestrator`, #339; and Discogs "Orchestrated By").
    [
      'written-by',
      'composed by',
      'songwriter',
      'music by',
      'lyrics by',
      'arranged by',
      'arranger',
      'orchestrat',
    ],
  ],
  ['producer', ['producer']],
  [
    'engineer',
    [
      'engineer',
      'recorded by',
      'mixed by',
      'mastered by',
      'lacquer cut by',
      'technician',
      'cut by',
    ],
  ],
  [
    'visual',
    [
      'photography',
      'artwork',
      'design',
      'illustration',
      'sleeve',
      'liner notes',
      'layout',
      'cover',
    ],
  ],
  ['crew', ['management', 'coordinator', 'a&r', 'legal', 'catered by']],
];

/**
 * Tokenize a comma-delimited Discogs role string for keyword matching.
 * Splits on commas; per segment emits the bracket-stripped base token plus each
 * [...] inner as a separate lowercased token, dropping empties. Shared by
 * parseRoleCategory and parseInstrument so their tokenization cannot drift.
 */
function tokenizeRole(role: string): string[] {
  const tokens: string[] = [];
  for (const segment of role.split(',')) {
    const base = segment
      .replace(/\[.*?\]/g, '')
      .trim()
      .toLowerCase();
    if (base.length > 0) tokens.push(base);
    for (const match of segment.matchAll(/\[([^\]]*)\]/g)) {
      const inner = match[1]!.trim().toLowerCase();
      if (inner.length > 0) tokens.push(inner);
    }
  }
  return tokens;
}

/**
 * Derive a role category from a comma-delimited Discogs role string.
 * Each token is checked against the lookup table using substring matching.
 * Bracket content is also scanned as additional tokens — some roles encode
 * the real category inside brackets (e.g. "Other [Catered By]" → "crew").
 * Falls back to "other" when no category matches.
 */
export function parseRoleCategory(role: string): RoleCategory {
  const tokens = tokenizeRole(role);
  for (const [category, keywords] of ROLE_CATEGORY_RULES) {
    for (const token of tokens) {
      for (const keyword of keywords) {
        if (token.includes(keyword)) return category;
      }
    }
  }

  return 'other';
}

export type Instrument =
  | 'bass'
  | 'guitar'
  | 'drums'
  | 'percussion'
  | 'vocals'
  | 'piano'
  | 'keyboards'
  | 'organ'
  | 'synthesizer'
  | 'saxophone'
  | 'trumpet'
  | 'trombone'
  | 'tuba'
  | 'horn'
  | 'violin'
  | 'viola'
  | 'cello'
  | 'strings'
  | 'flute'
  | 'clarinet'
  | 'oboe'
  | 'bassoon'
  | 'harmonica'
  | 'banjo'
  | 'mandolin'
  | 'sitar'
  | 'harp'
  | 'harpsichord'
  | 'accordion'
  | 'vibraphone';

// Priority-ordered: the first family whose keyword substring-matches any token wins.
// ORDER IS LOAD-BEARING — it disambiguates multi-instrument credit strings:
//   • drums + clarinet BEFORE bass     → "Bass Drum [Kick]" → drums, "Bass Clarinet" → clarinet
//   • bass BEFORE guitar               → "Bass Guitar" → bass (and "String Bass" → bass)
//   • vibraphone BEFORE percussion     → "Marimba" → vibraphone, not generic percussion
//   • bowed (violin/viola/cello) BEFORE strings → a named instrument beats a generic "Strings"
//   • bassoon BEFORE bass              → "Bassoon"/"Contrabassoon" contain 'bass' but aren't basses
//   • harpsichord BEFORE harp          → "Harpsichord" contains 'harp' but is a keyboard, not a harp
//   • harmonica BEFORE harp            → 'harp' is a substring of 'harmonica'
//   • synthesizer BEFORE keyboards     → a "Synthesizer [Moog]" credit isn't generic keys
const INSTRUMENT_RULES: ReadonlyArray<readonly [Instrument, readonly string[]]> = [
  ['drums', ['drums', 'drum']],
  ['clarinet', ['clarinet']],
  ['bassoon', ['bassoon']],
  ['bass', ['bass']],
  ['guitar', ['guitar', 'dobro']],
  ['vibraphone', ['vibraphone', 'vibes', 'marimba', 'xylophone']],
  [
    'percussion',
    [
      'percussion',
      'conga',
      'bongo',
      'tambourine',
      'shaker',
      'timbales',
      'cabasa',
      'cowbell',
      'claves',
      'maracas',
      'triangle',
      'chimes',
    ],
  ],
  ['vocals', ['vocals', 'vocal', 'voice', 'choir']],
  ['saxophone', ['saxophone', 'sax']],
  ['trumpet', ['trumpet', 'cornet']],
  ['trombone', ['trombone']],
  ['tuba', ['tuba']],
  ['horn', ['french horn', 'flugelhorn', 'horns', 'horn', 'brass']],
  ['violin', ['violin', 'fiddle']],
  ['viola', ['viola']],
  ['cello', ['cello']],
  ['strings', ['strings', 'string']],
  ['flute', ['flute']],
  ['oboe', ['oboe']],
  ['harmonica', ['harmonica', 'blues harp']],
  ['harpsichord', ['harpsichord']],
  ['harp', ['harp']],
  ['banjo', ['banjo']],
  ['mandolin', ['mandolin']],
  ['sitar', ['sitar']],
  ['accordion', ['accordion']],
  ['organ', ['hammond', 'organ']],
  ['piano', ['rhodes', 'wurlitzer', 'piano']],
  ['synthesizer', ['synthesizer', 'synth', 'moog', 'mellotron', 'clavinet']],
  ['keyboards', ['keyboards', 'keyboard', 'keys', 'celeste']],
];

/**
 * Derive a normalized instrument family from a comma-delimited Discogs role string.
 * Reuses parseRoleCategory's tokenization, then walks INSTRUMENT_RULES in priority
 * order and returns the first family whose keyword is a substring of any token.
 * Returns null when no instrument keyword matches (producers, engineers, visual,
 * crew, and anything uncatalogued).
 *
 * DERIVED value: the raw `role` and the first-token `displayRole` are kept verbatim
 * for provenance; this is stored separately as CREDITED_ON.instrument.
 *
 * Deliberately NOT gated on parseRoleCategory === 'performer': the role-category
 * performer keyword list is narrower than this vocabulary (e.g. "Trombone", "Viola",
 * "Clarinet" fall through to 'other'), so gating would silently drop real instruments.
 */
export function parseInstrument(role: string): Instrument | null {
  const tokens = tokenizeRole(role);
  for (const [instrument, keywords] of INSTRUMENT_RULES) {
    for (const token of tokens) {
      for (const keyword of keywords) {
        if (token.includes(keyword)) return instrument;
      }
    }
  }
  return null;
}

/**
 * Normalize a list of free-text instrument labels (e.g. Wikidata P1303 rdfs:labels like
 * "bass guitar", "drum kit") onto the #333 controlled instrument vocabulary by running each through
 * {@link parseInstrument}, dropping the ones that don't map, then deduping and sorting. The result is
 * the person-level companion to the per-credit CREDITED_ON.instrument axis (#393): the same shared
 * family vocabulary, so a query for "bass" lines up across both. Labels that fall outside the
 * 30-family vocab (theremin, kalimba, ukulele) are dropped here but preserved verbatim by the caller
 * (e.g. as playsInstrumentRaw) so nothing is silently lost.
 */
export function normalizeInstrumentFamilies(labels: readonly string[]): string[] {
  const families = new Set<Instrument>();
  for (const label of labels) {
    const family = parseInstrument(label);
    if (family !== null) families.add(family);
  }
  return [...families].sort();
}

/**
 * MusicBrainz `media.format` values that are purely digital. EXACT match only — NEVER a substring
 * test: a substring `'digital'` check would also catch "Digital Compact Cassette" (DCC), a physical
 * tape, and wrongly drop it. `'File'` is a Discogs value essentially never seen on MB's
 * `media.format`; kept defensively. (#458)
 */
const DIGITAL_FORMATS = new Set(['Digital Media', 'File']);

/**
 * Whether a release's formats are entirely digital. A worldwide digital edition is enumerated by
 * MusicBrainz as one ISO release-event per country storefront, which would otherwise saturate
 * MB_RELEASED_IN to ~every country (#458). True only when there is at least one format and every one
 * is in DIGITAL_FORMATS; an empty/unknown formats list is NOT digital — absence of format data is
 * not evidence of a digital release, and the saturation driver always carries "Digital Media".
 */
export function isDigitalOnlyRelease(formats: readonly string[]): boolean {
  return formats.length > 0 && formats.every((f) => DIGITAL_FORMATS.has(f));
}

// Priority-ordered: the first family whose keyword is a substring of the lowercased format wins.
// Grounded in MusicBrainz's un-prefixed `media.format` vocabulary (it returns "Vinyl", not
// "12\" Vinyl"). Physical-but-niche formats (DVD, Blu-ray, MiniDisc, DAT, Shellac, Download Card)
// fall through to 'other' — they are KEPT; only digital-only events are dropped (#458).
//   • '8-track'/'8 track' → "8-Track Cartridge"
//   • 'cassette' also matches "Digital Compact Cassette" (DCC) — a physical tape, not digital
//   • 'cd' matches CD/CD-R/HDCD/SHM-CD/Blu-spec CD/Enhanced CD; 'sacd' is redundant (contains 'cd')
//     but self-documents that SACD folds into the cd family
const FORMAT_FAMILY_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['8-track', ['8-track', '8 track']],
  ['cassette', ['cassette']],
  ['reel', ['reel']],
  ['vinyl', ['vinyl']],
  ['cd', ['cd', 'sacd']],
];

function formatFamily(format: string): string {
  const lower = format.toLowerCase();
  for (const [family, keywords] of FORMAT_FAMILY_RULES) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) return family;
    }
  }
  return 'other';
}

/**
 * Normalize a release's raw MusicBrainz formats onto a small controlled physical-medium vocabulary
 * (vinyl/cassette/cd/8-track/reel/other), excluding any digital format, then deduping + sorting
 * (mirrors {@link normalizeInstrumentFamilies}). Stored as MB_RELEASED_IN.formatFamilies alongside
 * the raw `formats` so physical-format reach analytics (e.g. "how many countries got a vinyl
 * pressing") stay clean without re-deriving spellings (#458). An all-digital list yields `[]` (every
 * token excluded), though such events are dropped upstream and never reach here.
 */
export function normalizeFormatFamilies(formats: readonly string[]): string[] {
  const families = new Set<string>();
  for (const format of formats) {
    if (DIGITAL_FORMATS.has(format)) continue;
    families.add(formatFamily(format));
  }
  return [...families].sort();
}

/**
 * Filter a tracklist to only real song entries.
 * Discogs uses type_ === "heading" for side labels ("Side A") and
 * type_ === "index" for indexed non-display entries. Only "track" entries are real songs.
 */
export function filterTracks(tracklist: DiscogsTracklistEntry[]): DiscogsTracklistEntry[] {
  return tracklist.filter((entry) => entry.type_ === 'track');
}

/**
 * Extract studio companies from a release's companies array.
 * Filters to entity_type "23" (Recorded At) and "27" (Mixed At).
 * NOTE: Filter by numeric entity_type code, not entity_type_name —
 * the name string is inconsistently capitalized across Discogs entries.
 */
export function extractStudios(companies: DiscogsCompany[]): DiscogsCompany[] {
  return companies.filter((c) => c.entity_type === '23' || c.entity_type === '27');
}

/**
 * Extract the barcode from a release's identifiers array.
 * Returns null when no Barcode identifier is present.
 */
export function extractBarcode(identifiers: DiscogsIdentifier[]): string | null {
  return identifiers.find((i) => i.type === 'Barcode')?.value ?? null;
}

/**
 * Extract the primary thumbnail URL from a release's images array.
 * Returns the uri150 of the first image with type === "primary", or null.
 */
export function extractThumbUrl(images: DiscogsImage[]): string | null {
  return images.find((i) => i.type === 'primary')?.uri150 ?? null;
}

/**
 * Parse a Discogs duration string into total seconds.
 * Handles "MM:SS" and "HH:MM:SS" formats. Returns null for empty, missing, or
 * unparseable values — never 0 for unknown duration.
 */
export function parseDurationSeconds(duration: string): number | null {
  if (!duration) return null;
  const parts = duration.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

/**
 * Determine whether a track is instrumental based on available signals.
 * Checks Discogs type_ and common title keywords. Note: type_ "index" entries
 * are filtered out by filterTracks() before ingestion, so in practice only
 * the title pattern fires on merged Track nodes.
 */
export function isInstrumental(track: DiscogsTracklistEntry): boolean {
  return track.type_ === 'index' || INSTRUMENTAL_PATTERNS.test(track.title);
}

// ---------------------------------------------------------------------------
// Country normalization (Issue 40, #441 — ADR 0005)
// ---------------------------------------------------------------------------
//
// `Country` is a multi-source controlled vocabulary: MusicBrainz/Wikidata emit ISO 3166-1 alpha-2
// codes (`GB`/`DE`/`JP`), Discogs emits names and regional-market strings (`UK`/`Germany`/`Japan`/
// `UK & Europe`). Keyed on the raw string they fragment — the same physical country lands on two
// nodes that never join (ADR 0005's GB/UK proof). `normalizeCountry` is the single classifier that
// resolves any raw token to ISO `:Country` codes **and** the separate `:Region` market tokens, so
// `:Country` stays pure ISO. It is applied at every Country/Region writer through the
// `mergeCountryClause`/`mergeRegionClause` chokepoints (canonical-merges.ts, ADR 0005 law 6).
//
// Regions are a genuinely different thing from countries — a regional-pressing SKU (`Europe`,
// `Worldwide`, `Scandinavia`, `UK & Europe`'s "Europe" half) — so they get a distinct label rather
// than being exploded into member countries (which would need a fuzzy region→members table and lose
// the regional-SKU fact; ADR 0005 "Alternatives rejected").

/** A raw market token resolved to zero-or-more ISO country codes and zero-or-more region tokens. */
export interface NormalizedCountry {
  countries: string[];
  regions: string[];
}

// Non-ISO single-country names/aliases → ISO 3166-1 alpha-2. The full set observed in prod
// (`MATCH (c:Country) RETURN c.name`, 2026-06-17). Already-ISO codes (the MusicBrainz/Wikidata
// emitters) are not listed — they pass through the `^[A-Z]{2}$` branch below.
const COUNTRY_CODES = new Map<string, string>([
  ['US', 'US'],
  ['USA', 'US'],
  ['UK', 'GB'],
  ['England', 'GB'],
  ['Scotland', 'GB'],
  ['Wales', 'GB'],
  ['Angola', 'AO'],
  ['Argentina', 'AR'],
  ['Australia', 'AU'],
  ['Austria', 'AT'],
  ['Bahrain', 'BH'],
  ['Barbados', 'BB'],
  ['Belgium', 'BE'],
  ['Bolivia', 'BO'],
  ['Brazil', 'BR'],
  ['Bulgaria', 'BG'],
  ['Canada', 'CA'],
  ['Chile', 'CL'],
  ['China', 'CN'],
  ['Colombia', 'CO'],
  ['Costa Rica', 'CR'],
  ['Croatia', 'HR'],
  ['Czech Republic', 'CZ'],
  ['Denmark', 'DK'],
  ['Dominican Republic', 'DO'],
  ['Ecuador', 'EC'],
  ['Egypt', 'EG'],
  ['El Salvador', 'SV'],
  ['Ethiopia', 'ET'],
  ['Finland', 'FI'],
  ['France', 'FR'],
  ['Germany', 'DE'],
  ['Ghana', 'GH'],
  ['Greece', 'GR'],
  ['Guatemala', 'GT'],
  ['Honduras', 'HN'],
  ['Hong Kong', 'HK'],
  ['Hungary', 'HU'],
  ['Iceland', 'IS'],
  ['India', 'IN'],
  ['Indonesia', 'ID'],
  ['Iran', 'IR'],
  ['Ireland', 'IE'],
  ['Israel', 'IL'],
  ['Italy', 'IT'],
  ['Jamaica', 'JM'],
  ['Japan', 'JP'],
  ['Kenya', 'KE'],
  ['Korea', 'KR'],
  ['Lebanon', 'LB'],
  ['Lithuania', 'LT'],
  ['Luxembourg', 'LU'],
  ['Malaysia', 'MY'],
  ['Mexico', 'MX'],
  ['Mozambique', 'MZ'],
  ['Netherlands', 'NL'],
  ['New Zealand', 'NZ'],
  ['Nicaragua', 'NI'],
  ['Nigeria', 'NG'],
  ['Norway', 'NO'],
  ['Pakistan', 'PK'],
  ['Panama', 'PA'],
  ['Paraguay', 'PY'],
  ['Peru', 'PE'],
  ['Philippines', 'PH'],
  ['Poland', 'PL'],
  ['Portugal', 'PT'],
  ['Romania', 'RO'],
  ['Russia', 'RU'],
  ['Saudi Arabia', 'SA'],
  ['Serbia', 'RS'],
  ['Singapore', 'SG'],
  ['South Africa', 'ZA'],
  ['South Korea', 'KR'],
  ['Spain', 'ES'],
  ['Sweden', 'SE'],
  ['Switzerland', 'CH'],
  ['Syria', 'SY'],
  ['Taiwan', 'TW'],
  ['Thailand', 'TH'],
  ['Turkey', 'TR'],
  ['Ukraine', 'UA'],
  ['United Arab Emirates', 'AE'],
  ['Uruguay', 'UY'],
  ['Venezuela', 'VE'],
  ['Zambia', 'ZM'],
  ['Zimbabwe', 'ZW'],
]);

// Supranational market codes → region token. `EU`/`WW` mirror the short-code convention; MusicBrainz
// emits `XE` (Europe) / `XW` ([Worldwide]) for these, which must map to regions so `:Country` never
// gains a non-ISO pseudo-code.
const REGION_CODES = new Map<string, string>([
  ['Europe', 'EU'],
  ['EU', 'EU'],
  ['Worldwide', 'WW'],
  ['WW', 'WW'],
  ['XE', 'EU'],
  ['XW', 'WW'],
]);

// Multi-country / fuzzy market names that are their own region token (no short code).
const REGION_NAMES = new Set<string>([
  'Scandinavia',
  'Benelux',
  'Asia',
  'Australasia',
  'South East Asia',
  'Middle East',
  'CIS',
  'Gulf Cooperation Council',
  'North America',
]);

// Compound Discogs markets → the mix of concrete ISO countries + region tokens they denote. Concrete
// enumerable members become countries; supranational parts (`Europe`→EU, `Benelux`, CIS) stay regions.
const COMPOUND_MARKETS = new Map<string, NormalizedCountry>([
  ['USA & Canada', { countries: ['US', 'CA'], regions: [] }],
  ['US & Canada', { countries: ['US', 'CA'], regions: [] }],
  ['Australia & New Zealand', { countries: ['AU', 'NZ'], regions: [] }],
  ['UK & Ireland', { countries: ['GB', 'IE'], regions: [] }],
  ['UK & US', { countries: ['GB', 'US'], regions: [] }],
  ['Czech Republic & Slovakia', { countries: ['CZ', 'SK'], regions: [] }],
  ['Germany, Austria, & Switzerland', { countries: ['DE', 'AT', 'CH'], regions: [] }],
  ['Singapore & Malaysia', { countries: ['SG', 'MY'], regions: [] }],
  ['Singapore, Malaysia & Hong Kong', { countries: ['SG', 'MY', 'HK'], regions: [] }],
  [
    'Singapore, Malaysia, Hong Kong & Thailand',
    { countries: ['SG', 'MY', 'HK', 'TH'], regions: [] },
  ],
  ['Hong Kong & Thailand', { countries: ['HK', 'TH'], regions: [] }],
  ['UK & Europe', { countries: ['GB'], regions: ['EU'] }],
  ['Europe & UK', { countries: ['GB'], regions: ['EU'] }],
  ['Europe & US', { countries: ['US'], regions: ['EU'] }],
  ['US & Europe', { countries: ['US'], regions: ['EU'] }],
  ['USA & Europe', { countries: ['US'], regions: ['EU'] }],
  ['UK, Europe & US', { countries: ['GB', 'US'], regions: ['EU'] }],
  ['USA, Canada & Europe', { countries: ['US', 'CA'], regions: ['EU'] }],
  ['France & Benelux', { countries: ['FR'], regions: ['Benelux'] }],
  ['Russia & CIS', { countries: ['RU'], regions: ['CIS'] }],
  ['North America (inc Mexico)', { countries: [], regions: ['North America'] }],
]);

/**
 * Resolve a raw Discogs/MusicBrainz country string into ISO `:Country` codes and `:Region` tokens.
 *
 * Lookup order is load-bearing: compound markets and the alias/region maps are consulted **before**
 * the `^[A-Z]{2}$` already-ISO passthrough, so two-letter aliases (`UK`→`GB`) and MB pseudo-codes
 * (`XE`→region `EU`) collapse instead of leaking through as bogus countries.
 *
 * Unmapped values fall back to a single `:Country` keyed on the raw string — data is never silently
 * dropped. Defunct states (`Yugoslavia`, `Czechoslovakia`, `USSR`, the GDR, `Netherlands Antilles`,
 * `Rhodesia`) deliberately take this path: they have no current ISO 3166-1 code and the historic
 * 3166-3 codes are reassigned/ambiguous, so they stay readable name-keyed nodes (ADR 0005).
 */
export function normalizeCountry(raw: string): NormalizedCountry {
  const token = raw.trim();
  const compound = COMPOUND_MARKETS.get(token);
  if (compound) return compound;
  const regionCode = REGION_CODES.get(token);
  if (regionCode) return { countries: [], regions: [regionCode] };
  if (REGION_NAMES.has(token)) return { countries: [], regions: [token] };
  const countryCode = COUNTRY_CODES.get(token);
  if (countryCode) return { countries: [countryCode], regions: [] };
  if (/^[A-Z]{2}$/.test(token)) return { countries: [token], regions: [] };
  return { countries: [token], regions: [] };
}
