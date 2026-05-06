// Pure data transformation functions for Discogs API responses.
// No I/O — all functions are deterministic and unit-testable.

import type {
  DiscogsCompany,
  DiscogsImage,
  DiscogsIdentifier,
  DiscogsTracklistEntry,
} from './types.js';

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
