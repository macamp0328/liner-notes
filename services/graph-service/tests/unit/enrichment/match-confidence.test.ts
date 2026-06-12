import { describe, it, expect } from 'vitest';
import { normalizeForMatch, titleSimilarity } from '../../../src/enrichment/match-confidence.js';

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
