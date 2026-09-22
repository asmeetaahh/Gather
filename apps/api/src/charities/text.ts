/**
 * Pure text helpers for the charity directory.
 *
 * SEARCH SAFETY. Free text typed by a visitor becomes a PostgreSQL `tsquery`. Only LETTER/DIGIT runs are
 * kept and each is used as a prefix term, so no tsquery operator or PostgREST filter syntax (`& | ! ( ) : * ,`
 * quotes, dots) can ever be injected: whatever the visitor types, the query is a plain AND of word prefixes.
 */

const WORD = /[\p{L}\p{N}]+/gu;

/** The searchable words in `q`: lower-cased letter/digit runs, at most `maxWords`, each cut to `maxLength`. */
export function searchWords(q: string, maxWords = 8, maxLength = 40): string[] {
  return (q.match(WORD) ?? [])
    .slice(0, maxWords)
    .map((word) => word.slice(0, maxLength).toLowerCase());
}

/**
 * The `to_tsquery` text for a search box entry — `"river you"` → `"river:* & you:*"` (type-ahead: each word
 * matches the START of a word) — or `null` when `q` has no searchable word (e.g. `"!!!"`).
 */
export function toPrefixTsQuery(q: string): string | null {
  const words = searchWords(q);
  return words.length > 0 ? words.map((word) => `${word}:*`).join(' & ') : null;
}

/** The start of `text`, at most `max` characters, cut at a word boundary with an ellipsis when shortened. */
export function summarize(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.replace(/[\s.,;:!?-]+$/, '')}…`;
}
