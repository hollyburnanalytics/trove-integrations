/**
 * Small text/date helpers shared by the WorkSafeBC COR server modules. The app
 * serves HTML-escaped values inside its JSON as well as in its markup, so the
 * same decoding runs over both.
 */

/** Decode the handful of named entities the app emits, plus numeric ones. */
export function decodeEntities(text: string): string {
  return text
    .replaceAll(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([\da-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number(`0x${hex}`)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&') // last, so nothing is double-decoded
    .trim();
}

/** Reduce an HTML fragment to trimmed plain text (`null` when nothing is left). */
export function cellText(html: string): string | null {
  const text = decodeEntities(html.replaceAll(/<[^<>]*>/g, ' '))
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

/** Normalize WorkSafeBC's `YYYY/MM/DD` to ISO `YYYY-MM-DD` (other shapes pass through). */
export function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(raw.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : raw.trim();
}

/**
 * True when `date` is strictly before today (UTC), false when it is not, and
 * null when there is no parseable date.
 *
 * This is a guard, not a common case: across 739 certificate rows sampled from
 * five certifying partners, **no** already-expired certificate appeared — the
 * earliest expiry in the sample was two days out — so WorkSafeBC appears to
 * list only current certificates. The flag stays because "appears to" is not
 * "guarantees", the sample cannot see the details pages, and a certificate that
 * lapses between publication and reading costs nothing to catch. It should not
 * be read as evidence that the registry serves stale certificates.
 */
export function isExpired(date: string | null): boolean | null {
  if (!date) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return parsed < Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
}

/** WorkSafeBC prints account numbers zero-padded to nine digits. */
export const accountNumber = (employerId: number): string => String(employerId).padStart(9, '0');

/** A `n more not shown` footer, so one page is never mistaken for the whole set. */
export function pageNote(total: number, shown: number, page: number, pageSize: number): string {
  const seen = (page - 1) * pageSize + shown;
  return total > seen ? `\n${total - seen} more not shown — request page ${page + 1}.` : '';
}
