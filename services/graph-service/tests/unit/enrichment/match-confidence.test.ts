import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  titleSimilarity,
  artistSimilarity,
  scoreLyricsMatch,
  isConfidentMatch,
  LYRICS_CONFIDENCE_DEFAULT,
} from '../../../src/enrichment/match-confidence.js';

// ---------------------------------------------------------------------------
// normalizeForMatch
// ---------------------------------------------------------------------------
describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation and whitespace', () => {
    expect(normalizeForMatch('Blue in Green!')).toBe('blueingreen');
  });

  it('strips diacritics', () => {
    expect(normalizeForMatch('Café Olé')).toBe('cafeole');
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeForMatch('—()[]')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// titleSimilarity
// ---------------------------------------------------------------------------
describe('titleSimilarity', () => {
  it('returns 1 for an exact normalized match', () => {
    expect(titleSimilarity('So What', 'so what!')).toBe(1);
  });

  it('returns 0 when either title is empty after normalization', () => {
    expect(titleSimilarity('()', 'Real Title')).toBe(0);
  });

  it('scores near-identical titles highly', () => {
    expect(titleSimilarity('Freddie Freeloader', 'Freddie Freeloaderr')).toBeGreaterThan(0.85);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('So What', 'Flamenco Sketches')).toBeLessThan(0.5);
  });

  it('returns 0 when a single-character title yields no bigrams', () => {
    expect(titleSimilarity('a', 'bc')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// artistSimilarity
// ---------------------------------------------------------------------------
describe('artistSimilarity', () => {
  it('returns 1 for the same artist regardless of punctuation/case', () => {
    expect(artistSimilarity('Miles Davis', 'miles davis!')).toBe(1);
  });

  it('scores unrelated artists low', () => {
    expect(artistSimilarity('Cymande', 'John Coltrane')).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// scoreLyricsMatch
// ---------------------------------------------------------------------------
describe('scoreLyricsMatch', () => {
  it('scores a perfect title+artist match with agreeing duration at 1.0', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: 'Miles Davis', durationSeconds: 545 },
      { matchedTitle: 'So What', matchedArtist: 'Miles Davis', matchedDurationSeconds: 548 },
    );
    expect(score.confidence).toBe(1);
    expect(score.durationOk).toBe(true);
  });

  it('halves confidence when durations are known and disagree (live/remix class)', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: 'Miles Davis', durationSeconds: 545 },
      { matchedTitle: 'So What', matchedArtist: 'Miles Davis', matchedDurationSeconds: 720 },
    );
    expect(score.durationOk).toBe(false);
    expect(score.confidence).toBe(0.5);
    expect(isConfidentMatch(score)).toBe(false);
  });

  it('does not penalize unknown duration — confidence rests on title+artist (Genius path)', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: 'Miles Davis', durationSeconds: 545 },
      { matchedTitle: 'So What', matchedArtist: 'Miles Davis', matchedDurationSeconds: null },
    );
    expect(score.durationOk).toBeNull();
    expect(score.confidence).toBe(1);
    expect(isConfidentMatch(score)).toBe(true);
  });

  it('takes the min of the two axes (a wrong artist is not papered over by a perfect title)', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: 'Miles Davis', durationSeconds: null },
      { matchedTitle: 'So What', matchedArtist: 'Cymande', matchedDurationSeconds: null },
    );
    expect(score.titleSim).toBe(1);
    expect(score.confidence).toBe(score.artistSim);
    expect(isConfidentMatch(score)).toBe(false);
  });

  it('treats an empty query artist as the artist axis absent (gates on title+duration only)', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: null, durationSeconds: 545 },
      { matchedTitle: 'So What', matchedArtist: 'Whoever', matchedDurationSeconds: 548 },
    );
    expect(score.artistSim).toBe(1);
    expect(score.confidence).toBe(1);
  });

  it('treats an absent matched title as the title axis absent (defensive, not a 0)', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: 'Miles Davis', durationSeconds: 545 },
      { matchedTitle: null, matchedArtist: 'Miles Davis', matchedDurationSeconds: 548 },
    );
    expect(score.titleSim).toBe(1);
    expect(score.confidence).toBe(1);
  });

  it('scores near-zero when both axes are weak and duration disagrees', () => {
    const score = scoreLyricsMatch(
      { title: 'So What', artist: 'Miles Davis', durationSeconds: 200 },
      { matchedTitle: 'Flamenco Sketches', matchedArtist: 'Cymande', matchedDurationSeconds: 400 },
    );
    expect(score.confidence).toBeLessThan(0.3);
    expect(isConfidentMatch(score)).toBe(false);
  });

  // The #31 wrong-song corruption class: the artist matches, but the search resolved a different
  // song. min(titleSim, artistSim) collapses to the low title similarity → rejected by the gate.
  describe('#31 regression fixtures — wrong-song matches must score below the gate', () => {
    const wrongSong: ReadonlyArray<[artist: string, queryTitle: string, matchedTitle: string]> = [
      ['Stephen Stills', 'Stop', 'Love Story'],
      ['Cymande', 'Zion I', 'Road to Zion'],
      ['Johnny Guitar Watson', 'Guitar Disco', 'Gangster of Love'],
      ['Birdlegs & Pauline', 'Pauline', 'Mist Of A Dream'],
    ];

    it.each(wrongSong)('rejects %s "%s" → "%s"', (artist, queryTitle, matchedTitle) => {
      const score = scoreLyricsMatch(
        { title: queryTitle, artist, durationSeconds: null },
        { matchedTitle, matchedArtist: artist, matchedDurationSeconds: null },
      );
      expect(isConfidentMatch(score)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isConfidentMatch
// ---------------------------------------------------------------------------
describe('isConfidentMatch', () => {
  const at = (confidence: number) => ({ confidence, titleSim: 1, artistSim: 1, durationOk: null });

  it('accepts at exactly the default threshold (>=)', () => {
    expect(isConfidentMatch(at(LYRICS_CONFIDENCE_DEFAULT))).toBe(true);
  });

  it('rejects just below the default threshold', () => {
    expect(isConfidentMatch(at(0.849))).toBe(false);
  });

  it('honors an explicit threshold override', () => {
    expect(isConfidentMatch(at(0.7), 0.6)).toBe(true);
    expect(isConfidentMatch(at(0.7), 0.8)).toBe(false);
  });
});
