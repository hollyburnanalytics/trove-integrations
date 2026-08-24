/** Reduce an HTML fragment to clean, entity-decoded plain text (or null if empty). */
export function htmlToText(html: string): string | null {
  const text = html
    .replaceAll(/<[^<>]+>/g, ' ')
    .replaceAll(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll(/&#39;|&apos;/g, "'")
    .replaceAll('&amp;', '&') // last, so we don't double-decode
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}
