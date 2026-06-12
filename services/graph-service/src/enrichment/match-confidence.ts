// Pure, I/O-free text-matching primitives shared by the MusicBrainz track matcher
// (`track-musicbrainz.ts`) and the lyrics match-confidence gate (`lyrics.ts`, issue #248).
// Kept in one module so both score titles/durations with the *same* normalization and
// similarity — no drift between "is this the same recording?" decisions across the codebase.

/** Title/artist similarity at or above this value counts two strings as the same. */
export const TITLE_SIMILARITY_THRESHOLD = 0.85;
/** Maximum allowed gap between two durations, in seconds, to count as the same recording. */
export const DURATION_TOLERANCE_SECONDS = 5;

/**
 * Normalize a title/artist for comparison: strip diacritics via NFKD, lowercase, and drop every
 * character that is not an ASCII letter or digit. "Café (Take 2)" → "cafetake2".
 * Non-Latin scripts normalize to an empty string (which scores 0 in titleSimilarity).
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i++) {
    grams.push(value.slice(i, i + 2));
  }
  return grams;
}

/**
 * Sørensen–Dice coefficient over character bigrams of the normalized strings.
 * Returns 1 for an exact normalized match and 0 when either side is empty.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;

  const aGrams = bigrams(na);
  const bGrams = bigrams(nb);
  if (aGrams.length === 0 || bGrams.length === 0) return 0;

  const bCounts = new Map<string, number>();
  for (const gram of bGrams) {
    bCounts.set(gram, (bCounts.get(gram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const gram of aGrams) {
    const remaining = bCounts.get(gram) ?? 0;
    if (remaining > 0) {
      intersection++;
      bCounts.set(gram, remaining - 1);
    }
  }

  return (2 * intersection) / (aGrams.length + bGrams.length);
}
