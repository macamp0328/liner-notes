import { describe, it, expect } from 'vitest';
import {
  decodeHtmlEntities,
  htmlToText,
  extractLyricsFromHtml,
  isValidGeniusLyrics,
  normalizeArtistName,
} from '../../../src/enrichment/lyrics-extract.js';

// These pure functions are the exact extractor/validator the production lyrics
// enrichment (lyrics.ts) and the offline Genius-contribution probe both rely on.
// They carry CodeQL-hardening guarantees (no double-escaping, no reconstructable
// markup), so they are tested directly here rather than only through enrichLyrics.

describe('decodeHtmlEntities', () => {
  it('decodes the supported named entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeHtmlEntities('a &lt;b&gt; c')).toBe('a <b> c');
    expect(decodeHtmlEntities('he said &quot;hi&quot;')).toBe('he said "hi"');
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
    expect(decodeHtmlEntities('em&mdash;dash')).toBe('em—dash');
    expect(decodeHtmlEntities('don&rsquo;t')).toBe('don’t');
  });

  it('leaves unknown named entities untouched', () => {
    expect(decodeHtmlEntities('a &fake; b')).toBe('a &fake; b');
  });

  it('decodes decimal and hex numeric entities (both cases of x)', () => {
    expect(decodeHtmlEntities('&#65;&#66;&#67;')).toBe('ABC');
    expect(decodeHtmlEntities('&#x41;&#x42;')).toBe('AB');
    expect(decodeHtmlEntities('&#X41;')).toBe('A');
  });

  it('leaves out-of-range numeric code points as the raw match', () => {
    // > 0x10FFFF — String.fromCodePoint would throw, so the guard returns the match.
    expect(decodeHtmlEntities('x&#9999999999;y')).toBe('x&#9999999999;y');
  });

  it('does not double-unescape (single pass): &#38;lt; stays &lt;, never <', () => {
    expect(decodeHtmlEntities('&#38;lt;')).toBe('&lt;');
  });
});

describe('htmlToText', () => {
  it('removes <script> and <style> blocks including their content', () => {
    const html = 'keep<script>evil()</script>this<style>.a{}</style>too';
    expect(htmlToText(html)).toBe('keepthistoo');
  });

  it('removes nested script blocks via the fixpoint loop', () => {
    // A single pass would leave the outer block reconstructable.
    const html = 'a<script><script>x</script></script>b';
    expect(htmlToText(html)).toBe('ab');
  });

  it('strips a script tag reconstructable only after one tag-strip pass', () => {
    expect(htmlToText('a<scr<script>oops</script>ipt>b')).toBe('ab');
  });

  it('converts <br> variants to newlines', () => {
    expect(htmlToText('line1<br>line2<br/>line3<br />line4')).toBe('line1\nline2\nline3\nline4');
  });

  it('removes an entity-encoded script tag (decode-before-strip ordering)', () => {
    const html = '&lt;script&gt;alert(1)&lt;/script&gt;safe';
    const out = htmlToText(html);
    expect(out).not.toContain('script');
    expect(out).toContain('safe');
  });

  it('drops stray angle brackets that do not form a tag pair', () => {
    expect(htmlToText('a>b<c')).toBe('abc');
  });

  it('trims surrounding whitespace', () => {
    expect(htmlToText('  hello  ')).toBe('hello');
  });
});

describe('extractLyricsFromHtml', () => {
  it('returns null when there is no lyrics container', () => {
    expect(extractLyricsFromHtml('<div>nope</div>')).toBeNull();
  });

  it('extracts text from a single container', () => {
    const html = '<div data-lyrics-container="true">Hello<br>World</div>';
    expect(extractLyricsFromHtml(html)).toBe('Hello\nWorld');
  });

  it('captures the full body past nested inner divs (balanced depth)', () => {
    // A non-greedy regex would stop at the first </div> and lose "second".
    const html = '<div data-lyrics-container="true">first<div class="x">middle</div>second</div>';
    expect(extractLyricsFromHtml(html)).toBe('firstmiddlesecond');
  });

  it('joins multiple containers with a blank line', () => {
    const html =
      '<div data-lyrics-container="true">verse one</div>' +
      '<p>annotation noise</p>' +
      '<div data-lyrics-container="true">verse two</div>';
    expect(extractLyricsFromHtml(html)).toBe('verse one\n\nverse two');
  });

  it('returns null when a container is never closed', () => {
    const html = '<div data-lyrics-container="true">unterminated';
    expect(extractLyricsFromHtml(html)).toBeNull();
  });
});

describe('isValidGeniusLyrics', () => {
  it('accepts ordinary lyric text', () => {
    expect(isValidGeniusLyrics('Imagine all the people\nLiving for today')).toBe(true);
  });

  it('rejects content longer than 15k characters', () => {
    expect(isValidGeniusLyrics('a'.repeat(15_001))).toBe(false);
  });

  it('rejects Genius contributor header blocks (case-insensitive)', () => {
    expect(isValidGeniusLyrics('12 Contributors\nTranslations\n…')).toBe(false);
    expect(isValidGeniusLyrics('1 contributor and more')).toBe(false);
  });

  it('rejects a bare trailing "Lyrics" title match', () => {
    expect(isValidGeniusLyrics('Some Song Lyrics')).toBe(false);
    expect(isValidGeniusLyrics('Title Lyrics  ')).toBe(false);
  });
});

describe('normalizeArtistName', () => {
  it('lowercases, strips punctuation/accents, and collapses whitespace', () => {
    expect(normalizeArtistName('  Françoise   Hardy! ')).toBe('franoise hardy');
    expect(normalizeArtistName('AC/DC')).toBe('acdc');
    expect(normalizeArtistName('Earth, Wind & Fire')).toBe('earth wind fire');
  });

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeArtistName('!!!')).toBe('');
  });
});
