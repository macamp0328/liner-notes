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

/** Artist-name similarity — the same Sørensen–Dice machinery and normalizer as titleSimilarity. */
export function artistSimilarity(a: string, b: string): number {
  return titleSimilarity(a, b);
}

/**
 * Default confidence gate for accepting a lyrics match (#248). A distinct constant from
 * TITLE_SIMILARITY_THRESHOLD — they coincide today but are conceptually separate, so a future
 * title-threshold tweak must not silently move the lyrics gate. Overridable per call.
 */
export const LYRICS_CONFIDENCE_DEFAULT = 0.85;

/** The track we're trying to find lyrics for (from the graph). */
export interface LyricsMatchQuery {
  title: string;
  artist: string | null;
  durationSeconds: number | null;
}

/** What a lyrics source *thought* it matched (echoed back by LRCLIB / Genius). */
export interface LyricsMatchCandidate {
  matchedTitle: string | null;
  matchedArtist: string | null;
  matchedDurationSeconds: number | null;
}

export interface LyricsMatchScore {
  /** Combined confidence in [0, 1], rounded to 3dp. */
  confidence: number;
  titleSim: number;
  artistSim: number;
  /** true = durations agree within tolerance, false = disagree, null = unknown (not penalized). */
  durationOk: boolean | null;
}

/**
 * Score how confident we are that a source's matched candidate is the same recording as the
 * query track (#248). Catches the #31 corruption class (artist matched, wrong song) and the
 * live/remix-with-different-lyrics class (duration disagreement).
 *
 * confidence = min(titleSim, artistSim) * durationFactor.
 * - `min` (not a weighted average): a match must be good on *both* axes — a perfect title can't
 *   paper over a wrong artist, and vice versa. This also makes the scorer source-agnostic: each
 *   source scores ~1 on its strong axis, so the weak axis governs (title for Genius, duration for
 *   LRCLIB via the factor below).
 * - durationFactor: 0.5 when durations are *known and disagree* (drags a title+artist-perfect hit
 *   below any sane gate → low-confidence), else 1.0. Soft (not a hard reject) so `confidence` stays
 *   a meaningful gradient.
 * - An absent axis scores 1.0, never 0: absence of a signal (no matched title/artist, or no query
 *   artist on a release with no RELEASED_BY) is not evidence *against* a match. Unknown duration
 *   (always for Genius) is likewise not penalized — penalizing it would gut Genius.
 */
export function scoreLyricsMatch(
  query: LyricsMatchQuery,
  candidate: LyricsMatchCandidate,
): LyricsMatchScore {
  const cTitle = candidate.matchedTitle;
  const titleSim = cTitle != null && cTitle !== '' ? titleSimilarity(query.title, cTitle) : 1;

  const qArtist = query.artist;
  const cArtist = candidate.matchedArtist;
  const artistSim =
    qArtist != null && qArtist !== '' && cArtist != null && cArtist !== ''
      ? artistSimilarity(qArtist, cArtist)
      : 1;

  const durationOk =
    query.durationSeconds != null && candidate.matchedDurationSeconds != null
      ? Math.abs(query.durationSeconds - candidate.matchedDurationSeconds) <=
        DURATION_TOLERANCE_SECONDS
      : null;

  const confidence =
    Math.round(Math.min(titleSim, artistSim) * (durationOk === false ? 0.5 : 1) * 1000) / 1000;

  return { confidence, titleSim, artistSim, durationOk };
}

/** Whether a scored match clears the confidence gate (defaults to {@link LYRICS_CONFIDENCE_DEFAULT}). */
export function isConfidentMatch(
  score: LyricsMatchScore,
  threshold: number = LYRICS_CONFIDENCE_DEFAULT,
): boolean {
  return score.confidence >= threshold;
}
