// Pure, I/O-free HTML extraction + validation primitives shared between the
// production lyrics enrichment (`lyrics.ts`) and the offline measurement probe
// (`scripts/genius-contribution-probe.ts`). Keeping these in one module means the
// probe scores Genius pages with the *exact* extractor/validator prod uses — no
// drift, so a re-run always measures current behavior. The CodeQL-hardening
// rationale below is load-bearing; preserve it on any edit.

// The named HTML entities we decode in song lyrics, mapped to their characters.
// A Map (looked up with .get) rather than a plain object so a regex-derived key
// can't reach Object.prototype members (security/detect-object-injection).
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['mdash', '—'],
  ['ndash', '–'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
]);

// Decodes the most common HTML entities found in song lyrics.
//
// Single-pass decode: each match is consumed once and its replacement is never
// re-scanned, so a decoded character can't combine with neighbouring text to form
// a new entity that gets decoded again. The previous chained `.replace()` calls
// decoded numeric entities first, so input like `&#38;lt;` became `&lt;` and then
// `<` — a double-unescape that could reintroduce markup (CodeQL js/double-escaping).
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string): string => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codePoint = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      // Guard the Unicode range — String.fromCodePoint throws on out-of-range values.
      if (codePoint >= 0 && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
      return match;
    }
    return NAMED_ENTITIES.get(body) ?? match;
  });
}

// Converts an HTML fragment to plain text: drops <script>/<style> blocks (content
// and all), turns <br> into newlines, then strips remaining tags.
//
// Order matters for sanitization. Entities are decoded *first* so an entity-encoded
// tag (e.g. `&lt;script&gt;…&lt;/script&gt;`) becomes a real tag and is removed by the
// stripping below — decoding last would reconstruct that markup *after* stripping and
// hand it back as output (CodeQL js/incomplete-multi-character-sanitization). Every
// multi-character removal then runs in a fixpoint loop so a single pass can't leave a
// reconstructable pattern (e.g. nested `<script><script>…` blocks, or `<scr<script>ipt>`),
// and any leftover angle brackets are dropped so no `<script` fragment can survive. A
// genuine literal `<`/`>` in lyric text is a rare casualty of that final cleanup — an
// acceptable trade for plain-text output that can never carry markup.
export function htmlToText(html: string): string {
  let text = decodeHtmlEntities(html);

  // Drop <script>/<style> blocks (content and all). Looped: one pass can leave a
  // reconstructable block (e.g. nested <script><script>…</script></script>).
  let previousBlocks: string;
  do {
    previousBlocks = text;
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  } while (text !== previousBlocks);

  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags. Looped for the same reason (e.g. `<scr<script>ipt>`).
  let previousTags: string;
  do {
    previousTags = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previousTags);

  text = text.replace(/[<>]/g, '');
  return text.trim();
}

// Extracts plain text from <div data-lyrics-container> elements using a
// balanced-bracket depth counter to handle nested divs correctly.
// The previous regex approach used non-greedy matching which stopped at the
// first inner </div>, capturing only the header block Genius now prepends.
export function extractLyricsFromHtml(html: string): string | null {
  const OPEN_TAG = 'data-lyrics-container';
  const parts: string[] = [];
  let pos = 0;

  while (pos < html.length) {
    const attrIdx = html.indexOf(OPEN_TAG, pos);
    if (attrIdx === -1) break;

    const tagEnd = html.indexOf('>', attrIdx);
    if (tagEnd === -1) break;

    let depth = 1;
    let cursor = tagEnd + 1;
    let closingStart = -1;

    while (depth > 0 && cursor < html.length) {
      const nextOpen = html.indexOf('<div', cursor);
      const nextClose = html.indexOf('</div>', cursor);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        cursor = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) closingStart = nextClose;
        cursor = nextClose + 6;
      }
    }

    if (closingStart !== -1) {
      const raw = html.slice(tagEnd + 1, closingStart);
      const text = htmlToText(raw);
      if (text) parts.push(text);
      pos = closingStart + 6;
    } else {
      pos = tagEnd + 1;
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// Rejects content that is known garbage: Genius header blocks, bare title
// matches, and oversized results (books/articles scraped instead of lyrics).
export function isValidGeniusLyrics(text: string): boolean {
  if (text.length > 15_000) return false;
  if (/^\d+\s+Contributor/i.test(text)) return false;
  if (/\bLyrics\s*$/.test(text)) return false;
  return true;
}

export function normalizeArtistName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
