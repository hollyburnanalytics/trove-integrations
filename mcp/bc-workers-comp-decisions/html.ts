/** Reduce an HTML fragment to clean, entity-decoded plain text (or null if empty). */
export function htmlToText(html: string): string | null {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&') // last, so we don't double-decode
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}
