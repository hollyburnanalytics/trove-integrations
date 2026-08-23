/**
 * Source preparation and final tidy for the HTML → Markdown converter.
 *
 * The steps here bracket the tree walk: they decide what the walker is even
 * given (entity layers peeled, CDATA unwrapped, plain text recognized as plain)
 * and what the assembled output looks like afterwards.
 *
 * Every one of them exists because of a specific way real feeds are malformed,
 * and each is measured against the audit corpus described in `README.md`.
 * Between them they account for 199 of the 239 ingest-gate rejections that
 * corpus produced — the single largest category, and the one that stops feeds
 * rather than merely degrading documents.
 *
 * @module
 */

import { stripControlCharacters } from './markdown-emit.ts';
import { decodeHtmlEntities } from './text.ts';

/**
 * Unwrap `<![CDATA[…]]>` sections that arrived as literal text.
 *
 * A CDATA section is an XML parser's business and should never reach an HTML
 * parser. It does anyway: some publishers entity-encode the delimiters into the
 * feed (`&lt;![CDATA[&lt;p&gt;…`), so by the time the body is decoded the
 * markers are ordinary characters, and `node-html-parser` — correctly, for HTML
 * — treats the whole run as text. The visible symptom is a document whose body
 * begins `<![CDATA[<p><b><a href=…` in full, which the ingest gate rejects as raw
 * HTML. 179 of the 239 gate rejections in the audit corpus were this one shape,
 * and every one of them held a feed's cursor.
 *
 * @param source - The fragment as it arrived.
 * @returns The same fragment with the delimiters gone.
 */
export function unwrapCdata(source: string): string {
  return source.includes('<![CDATA[')
    ? source.replaceAll('<![CDATA[', '').replaceAll(']]>', '')
    : source;
}

/**
 * Reveal markup that was entity-encoded, however many times.
 *
 * One decode is not enough. A body can reach us DOUBLE-encoded — `&amp;lt;img
 * src=…` — usually because a CMS escaped an already-escaped field on the way
 * into the XML. A single pass turns that into `&lt;img src=…`, which still
 * contains no `<`, so the fragment is treated as plain prose, decoded once more
 * on the way out, and lands in the corpus as literal `<img src="…">`. That is 20
 * of the 33 gate rejections left in the audit corpus after every other fix, all
 * of them one publisher, all of them holding a feed's cursor.
 *
 * Bounded at three passes: the loop exists to reveal markup, and a body needing
 * a fourth decode is likelier to be prose about entities than more layers.
 *
 * @param html - The fragment, possibly entity-encoded more than once.
 * @returns The fragment with its markup revealed.
 */
export function decodeUntilMarkup(html: string): string {
  let value = html;
  for (let pass = 0; pass < 3 && !value.includes('<'); pass++) {
    if (!/&(lt|amp|#60|#x3c);/i.test(value)) break;
    const next = decodeHtmlEntities(value);
    if (next === value) break;
    value = next;
  }
  return value;
}

/**
 * Collapse an already-plain fragment's whitespace, keeping its line structure.
 *
 * @param source - The fragment, which parsed as containing no markup.
 * @returns Its text as Markdown.
 */
export function plainTextToMarkdown(source: string): string {
  return (
    stripControlCharacters(decodeHtmlEntities(decodeHtmlEntities(source)))
      // Escape anything still tag-shaped. Reaching here means the fragment had no
      // markup to parse, but the two decodes above can still expose a `<` — and
      // the gate rejects a body containing raw HTML outright.
      .replaceAll(/<(?=[a-zA-Z/!?])/g, String.raw`\<`)
      .split('\n')
      .map((line) => line.replaceAll(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      .replaceAll(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Tidy the assembled output: strip join artifacts and cap blank runs.
 *
 * @param markdown - The assembled document.
 * @returns The tidied document.
 */
export function tidy(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => {
      const trimmed = line.trimEnd();
      // Trailing spaces always go; a stray single leading space (an inline join
      // artifact) goes too, while deeper indentation — code blocks and nested
      // list items — is structural and kept.
      return trimmed.startsWith(' ') && !trimmed.startsWith('  ') ? trimmed.slice(1) : trimmed;
    })
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}
