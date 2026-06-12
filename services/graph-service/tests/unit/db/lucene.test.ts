import { describe, it, expect } from 'vitest';
import { escapeLuceneQuery } from '../../../src/db/lucene.js';

describe('escapeLuceneQuery', () => {
  it('escapes a lone double quote', () => {
    expect(escapeLuceneQuery('"')).toBe('\\"');
  });

  it('escapes an unbalanced open paren', () => {
    expect(escapeLuceneQuery('(')).toBe('\\(');
  });

  it('escapes wildcard and fuzzy operators (removes the CPU vector)', () => {
    expect(escapeLuceneQuery('*a*~')).toBe('\\*a\\*\\~');
  });

  it('strips < and > rather than escaping them', () => {
    expect(escapeLuceneQuery('<>')).toBe('  ');
    expect(escapeLuceneQuery('a<b>c')).toBe('a b c');
  });

  it('escapes a literal backslash exactly once', () => {
    expect(escapeLuceneQuery('\\')).toBe('\\\\');
  });

  it('lowercases bare uppercase boolean operators into plain terms', () => {
    expect(escapeLuceneQuery('AND')).toBe('and');
    expect(escapeLuceneQuery('a OR b NOT c')).toBe('a or b not c');
  });

  it('does not touch operator substrings inside a word', () => {
    expect(escapeLuceneQuery('ANDROID BANDANA')).toBe('ANDROID BANDANA');
  });

  it('leaves an ordinary multi-word query unchanged', () => {
    expect(escapeLuceneQuery('john coltrane')).toBe('john coltrane');
  });

  it('escapes the remaining classic special characters', () => {
    expect(escapeLuceneQuery('+-!:^[]{}?|&/')).toBe('\\+\\-\\!\\:\\^\\[\\]\\{\\}\\?\\|\\&\\/');
  });

  it('keeps common artist-name punctuation searchable as literal terms', () => {
    expect(escapeLuceneQuery('AC/DC')).toBe('AC\\/DC');
    expect(escapeLuceneQuery('Jay-Z')).toBe('Jay\\-Z');
  });
});
