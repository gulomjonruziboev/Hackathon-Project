/**
 * Whitespace/typography normalisation used when verifying that an LLM-provided
 * `source_quote` really occurs in the extracted document text (spec 9.2).
 * We normalise aggressively enough to survive PDF line-wrapping, but never
 * so aggressively that a different number or word would match.
 */
export function normalizeForQuoteMatch(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’ʼʹ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function quoteFoundInText(quote: string, text: string): boolean {
  const q = normalizeForQuoteMatch(quote);
  if (q.length < 3) return false;
  return normalizeForQuoteMatch(text).includes(q);
}

/** Character offset of the quote in the raw text, or null. Best effort, for UI highlighting. */
export function findQuoteOffset(quote: string, text: string): number | null {
  const direct = text.indexOf(quote);
  if (direct >= 0) return direct;
  const nq = normalizeForQuoteMatch(quote);
  const nt = normalizeForQuoteMatch(text);
  const idx = nt.indexOf(nq);
  return idx >= 0 ? idx : null;
}

/** Strip characters that would let extracted text be rendered as markup in the UI. */
export function plainText(input: string): string {
  return input.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}
