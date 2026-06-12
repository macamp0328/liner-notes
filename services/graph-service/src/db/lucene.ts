// Lucene classic-QueryParser escaping for Neo4j fulltext `db.index.fulltext.queryNodes` term
// queries. The procedure parses its query argument as Lucene syntax *before* the index analyzer
// runs, so an unbalanced paren, a stray quote, or a wildcard/fuzzy operator in raw user input
// throws a parse error (surfacing as an unhandled 500). Escaping turns the input into literal
// search terms so it can never trip the parser, and neutralises the wildcard/fuzzy CPU vector.
//
// Distinct from `escapeLucenePhrase` in ingestion/musicbrainz-client.ts, which only strips quotes
// for a value embedded inside an *already-quoted* phrase query. This escapes an *unquoted* term
// query, where the full special-character set matters.

// Classic QueryParser special characters, each backslash-escaped to a literal. Kept as a Set
// scanned character-by-character rather than a regex character class on purpose: a `/` inside a
// regex literal's `[...]` is a standing fight between Prettier (escapes it to `\/`) and ESLint
// (`no-useless-escape` rejects `\/`), so the literal form is unstable across tool versions.
const LUCENE_SPECIAL = new Set([
  '\\',
  '+',
  '-',
  '!',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '^',
  '"',
  '~',
  '*',
  '?',
  ':',
  '|',
  '&',
  '/',
]);
// Bare uppercase AND/OR/NOT are boolean operators; a leading or standalone one is itself a parse
// error (e.g. a query of just `AND`). Lowercasing turns them into ordinary terms — the index
// analyzer lowercases anyway, so this also makes a literal search for a name like "AND ALSO THE
// TREES" work instead of throwing. Only the uppercase forms are operators, so match case-sensitively.
const LUCENE_OPERATORS = /\b(?:AND|OR|NOT)\b/g;

/**
 * Escape user input so it is interpreted as literal terms by Lucene's classic query parser.
 *
 * `<` and `>` cannot be backslash-escaped in the classic parser, so they are stripped to spaces.
 * `&&`/`||`/`!` are already neutralised because `&`, `|`, and `!` are escaped. The result can be
 * all-whitespace (e.g. input `<>`); callers must treat that as "no query" rather than passing it to
 * `queryNodes`, which rejects an empty query.
 */
export function escapeLuceneQuery(q: string): string {
  let escaped = '';
  for (const ch of q) {
    if (ch === '<' || ch === '>') {
      escaped += ' ';
    } else if (LUCENE_SPECIAL.has(ch)) {
      escaped += `\\${ch}`;
    } else {
      escaped += ch;
    }
  }
  return escaped.replace(LUCENE_OPERATORS, (op) => op.toLowerCase());
}
