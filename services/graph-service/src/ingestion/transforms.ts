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
 * Derive the decade string from a release year.
 * e.g. 1972 → "1970s", 1980 → "1980s", 2000 → "2000s"
 */
export function deriveDecade(year: number): string {
  return `${Math.floor(year / 10) * 10}s`;
}

/**
 * Parse a track number from a Discogs position string.
 * Extracts the trailing numeric segment: "A1" → 1, "B3" → 3, "10" → 10.
 * Returns 0 when no numeric portion is found.
 */
export function parseTrackNumber(position: string): number {
  const numStr = /(\d+)$/.exec(position)?.[1];
  return numStr !== undefined ? parseInt(numStr, 10) : 0;
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
    ['written-by', 'composed by', 'songwriter', 'music by', 'lyrics by', 'arranged by', 'arranger'],
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
 * Derive a role category from a comma-delimited Discogs role string.
 * Each token is checked against the lookup table using substring matching.
 * Bracket content is also scanned as additional tokens — some roles encode
 * the real category inside brackets (e.g. "Other [Catered By]" → "crew").
 * Falls back to "other" when no category matches.
 */
export function parseRoleCategory(role: string): RoleCategory {
  const tokens: string[] = [];
  for (const segment of role.split(',')) {
    const base = segment
      .replace(/\[.*?\]/g, '')
      .trim()
      .toLowerCase();
    if (base.length > 0) tokens.push(base);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const match of segment.matchAll(/\[([^\]]*)\]/g)) {
      const inner = match[1]!.trim().toLowerCase();
      if (inner.length > 0) tokens.push(inner);
    }
  }

  for (const [category, keywords] of ROLE_CATEGORY_RULES) {
    for (const token of tokens) {
      for (const keyword of keywords) {
        if (token.includes(keyword)) return category;
      }
    }
  }

  return 'other';
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
// Country normalization (Issue 40)
// ---------------------------------------------------------------------------

// Discogs uses non-ISO regional codes and compound market strings.
// This map normalises them to canonical ISO 3166-1 alpha-2 codes (or regional
// tokens EU / WW). Compound values (e.g. "USA & Canada") expand to multiple
// codes. Unmapped values fall through as-is so no data is silently dropped.
const COUNTRY_NORMALIZATION: Readonly<Record<string, string[]>> = {
  US: ['US'],
  USA: ['US'],
  UK: ['GB'],
  England: ['GB'],
  Scotland: ['GB'],
  Wales: ['GB'],
  Europe: ['EU'],
  Germany: ['DE'],
  France: ['FR'],
  Japan: ['JP'],
  Canada: ['CA'],
  Australia: ['AU'],
  Netherlands: ['NL'],
  Italy: ['IT'],
  Spain: ['ES'],
  Brazil: ['BR'],
  Mexico: ['MX'],
  Sweden: ['SE'],
  Norway: ['NO'],
  Denmark: ['DK'],
  Finland: ['FI'],
  Belgium: ['BE'],
  Switzerland: ['CH'],
  Austria: ['AT'],
  Portugal: ['PT'],
  Greece: ['GR'],
  Poland: ['PL'],
  'Czech Republic': ['CZ'],
  Hungary: ['HU'],
  Russia: ['RU'],
  'South Korea': ['KR'],
  Korea: ['KR'],
  'New Zealand': ['NZ'],
  'South Africa': ['ZA'],
  Argentina: ['AR'],
  'USA & Canada': ['US', 'CA'],
  'US & Canada': ['US', 'CA'],
  'UK & Europe': ['GB', 'EU'],
  'Europe & UK': ['EU', 'GB'],
  'Europe & US': ['EU', 'US'],
  'US & Europe': ['US', 'EU'],
  Worldwide: ['WW'],
};

/**
 * Normalise a raw Discogs country string to an array of canonical codes.
 * Returns a single-element array for most inputs; compound market strings
 * (e.g. "USA & Canada") expand to multiple codes.
 * Unknown values fall back to [raw] — data is never silently discarded.
 */
export function normalizeCountry(raw: string): string[] {
  // eslint-disable-next-line security/detect-object-injection
  return COUNTRY_NORMALIZATION[raw] ?? [raw];
}

// ---------------------------------------------------------------------------
// Track title normalization (Issue 43)
// ---------------------------------------------------------------------------

const VERSION_TYPE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['remix', /remix|rmx/i],
  ['live', /\blive\b|concert|in concert/i],
  ['acoustic', /acoustic/i],
  ['demo', /\bdemo\b/i],
  ['alternate', /alternate|alternative|\balt\b\./i],
  ['instrumental', /instrumental/i],
];

/**
 * Strip version descriptors from a track title to produce a canonical base
 * title for matching across releases.
 * Strips: (parenthetical), [bracketed], and common prefix markers like
 * "Live - " or "Extended - ". Result is trimmed and lowercased.
 */
export function normalizeTrackTitle(title: string): string {
  return title
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/^(?:live|extended|acoustic|demo|alternate|instrumental)\s*[-–—]\s*/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Derive a version type by inspecting the content stripped from a track title
 * (parentheticals, brackets, and leading prefix markers).
 * Returns 'unknown' when no pattern matches.
 */
export function deriveVersionType(originalTitle: string): string {
  const fragments: string[] = [];

  for (const match of originalTitle.matchAll(/\(([^)]*)\)/g)) {
    if (match[1]) fragments.push(match[1]);
  }
  for (const match of originalTitle.matchAll(/\[([^\]]*)\]/g)) {
    if (match[1]) fragments.push(match[1]);
  }
  const prefixMatch = /^(live|extended|acoustic|demo|alternate|instrumental)\s*[-–—]\s*/i.exec(
    originalTitle,
  );
  if (prefixMatch?.[1]) fragments.push(prefixMatch[1]);

  const combined = fragments.join(' ').toLowerCase();

  for (const [type, pattern] of VERSION_TYPE_PATTERNS) {
    if (pattern.test(combined)) return type;
  }

  return 'unknown';
}
