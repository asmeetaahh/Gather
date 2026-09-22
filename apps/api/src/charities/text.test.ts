import { describe, expect, it } from 'vitest';
import { searchWords, summarize, toPrefixTsQuery } from './text.js';

describe('searchWords / toPrefixTsQuery (DIR-01: search, injection-proof)', () => {
  it('lower-cases and splits on anything that is not a letter or digit', () => {
    expect(searchWords('  Riverside,  YOUTH-fund! ')).toEqual(['riverside', 'youth', 'fund']);
  });

  it('builds an AND of word prefixes', () => {
    expect(toPrefixTsQuery('river you')).toBe('river:* & you:*');
    expect(toPrefixTsQuery('Ocean')).toBe('ocean:*');
  });

  it('returns null when there is nothing searchable', () => {
    for (const q of ['', '   ', '!!!', '&|!()', '"', "'--", ':*'])
      expect(toPrefixTsQuery(q), q).toBeNull();
  });

  it('keeps non-ASCII letters and digits', () => {
    expect(toPrefixTsQuery('Café Zürich 2026')).toBe('café:* & zürich:* & 2026:*');
  });

  it.each([
    "river'; drop table charities; --",
    'a & b | !c',
    'x:*) | (y',
    'name.ilike.%25',
    'a,b),(c',
    '{"a":1}',
    '\\',
  ])('can never produce tsquery/filter syntax from hostile input: %s', (q) => {
    const out = toPrefixTsQuery(q);
    if (out === null) return;
    // Only word prefixes joined by " & " — every character outside a word is one of : * space &
    expect(out).toMatch(/^[\p{L}\p{N}]+:\*( & [\p{L}\p{N}]+:\*)*$/u);
  });

  it('bounds the work: at most 8 words, each at most 40 characters', () => {
    expect(searchWords('a b c d e f g h i j k')).toHaveLength(8);
    expect(searchWords('x'.repeat(500))[0]).toHaveLength(40);
  });
});

describe('summarize', () => {
  it('returns short text unchanged, with whitespace collapsed', () => {
    expect(summarize('  A   short\n description. ')).toBe('A short description.');
  });

  it('cuts long text at a word boundary and adds an ellipsis', () => {
    const text = 'word '.repeat(100);
    const out = summarize(text, 50);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out).not.toMatch(/wor…$/);
  });

  it('does not leave dangling punctuation before the ellipsis', () => {
    expect(summarize('Helping young people, and more. '.repeat(20), 30)).not.toMatch(/[,.;:!?-]…$/);
  });

  it('hard-cuts a single very long word rather than returning nothing', () => {
    expect(summarize('x'.repeat(300), 20)).toBe(`${'x'.repeat(20)}…`);
  });

  it('is exact at the limit', () => {
    expect(summarize('a'.repeat(200))).toBe('a'.repeat(200));
    expect(summarize('a'.repeat(201)).endsWith('…')).toBe(true);
  });
});
