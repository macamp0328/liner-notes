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
