/**
 * Text helpers for feed source adapters: HTML entity decoding, tag stripping,
 * plain-text reduction, stable IDs, and safe date parsing. Feed bodies are
 * stored as lightweight Markdown — headings become `#` lines, list items `- `
 * lines, `<pre>` a fenced code block and inline `<code>` a backtick span — so
 * the reader renders them as structured text rather than one run-together
 * paragraph.
 */

import { createHash } from 'node:crypto';

/**
 * Strip HTML tags from a string by matching angle-bracketed sequences.
 * Uses a simple state-machine approach to avoid regex backtracking issues.
 *
 * @param {string} input - The markup to flatten.
 * @returns {string} Everything outside a tag.
 */
export function stripHtmlTags(input) {
  let result = '';
  let isInTag = false;
  for (const char of input) {
    if (char === '<') {
      isInTag = true;
    } else if (char === '>') {
      isInTag = false;
    } else if (!isInTag) {
      result += char;
    }
  }
  return result;
}

/**
 * Generate a stable, collision-resistant ID from a string.
 *
 * @param {string} prefix - Names the source, so ids from two sources never collide.
 * @param {string} input - The identity being hashed; the same input must hash the same forever.
 * @returns {string} The prefixed id.
 */
export function stableId(prefix, input) {
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

/**
 * Safely parse a date string. Returns a valid ISO string or undefined.
 *
 * @param {string} [dateString] - Whatever the feed published.
 * @returns {string | undefined} An ISO instant, or nothing — never a faked date.
 */
export function safeDate(dateString) {
  if (!dateString) return;
  const d = new Date(dateString);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Hour-of-day a `YYYY-MM-DD` instant lands on in `timeZone`.
 *
 * @param {Date} instant - The instant to read.
 * @param {string} timeZone - IANA zone.
 * @returns {number} The local hour, 0–23.
 */
function hourIn(instant, timeZone) {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).format(instant);
  return Number(hour) % 24; // some locales render midnight as "24"
}

/**
 * Convert a bare calendar day (`YYYY-MM-DD`) to the ISO instant for **noon** in
 * `timeZone`.
 *
 * A day-granular event (a council meeting, a filing) has no time of day, but it
 * still has to be stored as an instant. Storing midnight UTC is the tempting
 * default and it is wrong for anywhere west of Greenwich: `new Date('2026-07-20')`
 * is midnight UTC, which renders as *July 19* in Vancouver. Anchoring to local
 * noon puts the instant far enough from both midnights that it renders as the
 * intended calendar day across the Americas and Europe.
 *
 * DST is resolved by construction rather than by a hardcoded offset: we try each
 * plausible UTC offset and keep the one that actually lands on noon locally.
 *
 * @param {string} day - Calendar day as `YYYY-MM-DD`.
 * @param {string} timeZone - IANA zone, e.g. `'America/Vancouver'`.
 * @returns {string | undefined} ISO instant, or undefined if `day` is unparseable.
 */
export function dayToLocalNoonIso(day, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return safeDate(day);
  // Offsets are whole or half hours; 0..14 either side covers every real zone.
  for (let offset = -14; offset <= 14; offset += 0.5) {
    const instant = new Date(`${day}T12:00:00Z`);
    if (Number.isNaN(instant.getTime())) return;
    instant.setUTCMinutes(instant.getUTCMinutes() + offset * 60);
    if (hourIn(instant, timeZone) === 12) return instant.toISOString();
  }
}

/** The named entities feed bodies actually use, beyond the XML five. */
const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&middot;': '·',
};

/** @type {(match: string, digits: string) => string} */
const fromDecimal = (_, digits) => String.fromCodePoint(Number(digits));

/** @type {(match: string, hex: string) => string} */
const fromHex = (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16));

/**
 * Decode common HTML entities (numeric plus the named ones feeds use).
 *
 * @param {string} string_ - The text to decode.
 * @returns {string} The same text with entities resolved.
 */
export function decodeHtmlEntities(string_) {
  let result = string_
    .replaceAll(/&#(\d+);/g, (match, digits) => fromDecimal(match, digits))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (match, hex) => fromHex(match, hex))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    // A replacer function, not the string: a bare replacement is scanned for
    // `$&`-style patterns, and these characters come from a table rather than a
    // literal. None of them holds a `$` today, and nothing stops one being
    // added.
    result = result.replaceAll(entity, () => char);
  }
  return result.replaceAll('&amp;', '&'); // amp last so we don't double-decode
}

// Re-exported so the many callers of `htmlToText` keep one import. The
// implementation moved to `html-markdown.mjs`; the name stays because it is the
// vocabulary every source adapter already uses.
export { htmlToText } from './html-markdown.mjs';
