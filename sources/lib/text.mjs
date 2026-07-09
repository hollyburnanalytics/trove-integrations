/**
 * Text helpers for feed source adapters: HTML entity decoding, tag stripping,
 * plain-text reduction, stable IDs, and safe date parsing. Feed bodies are
 * stored as plain text (decoded, tags stripped) — we deliberately do not try to
 * reconstruct rich Markdown.
 */

import { createHash } from 'node:crypto';

/**
 * Strip HTML tags from a string by matching angle-bracketed sequences.
 * Uses a simple state-machine approach to avoid regex backtracking issues.
 */
export function stripHtmlTags(input) {
  let result = '';
  let inTag = false;
  for (const char of input) {
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
    } else if (!inTag) {
      result += char;
    }
  }
  return result;
}

/**
 * Generate a stable, collision-resistant ID from a string.
 */
export function stableId(prefix, input) {
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

/**
 * Safely parse a date string. Returns a valid ISO string or undefined.
 */
export function safeDate(dateString) {
  if (!dateString) return;
  const d = new Date(dateString);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Decode common HTML entities (including numeric).
 */
export function decodeHtmlEntities(string_) {
  return string_
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&'); // amp last so we don't double-decode
}

/**
 * Reduce an HTML (or already-plain) fragment to clean plain text: decode
 * entities, drop tags, and tidy whitespace while keeping line breaks. We store
 * feed bodies as raw text rather than (lossily) converting markup to Markdown.
 */
export function htmlToText(html) {
  if (!html) return '';
  // Decode → strip → decode: feed bodies are HTML that was itself entity-encoded
  // for XML embedding, so unwrapping one level exposes a second (e.g. `&amp;amp;`
  // → `&amp;` → `&`).
  return decodeHtmlEntities(stripHtmlTags(decodeHtmlEntities(html)))
    .split('\n')
    .map((line) => line.replaceAll(/[^\S\n]+/g, ' ').trim()) // tidy each line
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n') // cap consecutive blank lines
    .trim();
}
