/**
 * Which HTML element means what, for the Markdown walk.
 *
 * Pure classification, no rendering: the sets and lookup tables that say an
 * element is furniture to drop, ends a paragraph, ends a line, is a heading of
 * some level, or is inline emphasis. {@link module:html-markdown} walks the
 * tree; this decides what each node it lands on *is*.
 *
 * Split out when that file outgrew the per-file line limit. The split is along
 * the seam it already had — every one of these is consulted by the walker and
 * changed for a different reason (a new tag to drop is not a change to how
 * anything renders).
 *
 * @module
 */

/** Elements whose content never belongs in the stored text. */
export const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'head',
  'form',
  'button',
  'input',
  'select',
  'option',
  'audio',
  'video',
  'source',
]);

/** Elements that end a paragraph: a blank line on both sides. */
export const PARAGRAPH_TAGS = new Set(['p', 'blockquote', 'figure', 'dl']);

/** Heading tags to their ATX Markdown prefix. */
export const HEADING_MARKERS: Record<string, string> = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '####',
  h5: '#####',
  h6: '######',
};

/**
 * Elements that end a line: their content stands on its own line.
 *
 * `li`, `tr`, `td` and `th` are here as a SAFETY NET, not as their normal path —
 * inside a list or table they are consumed by `renderList`/`tableMatrix`, which
 * render their children directly and never reach this table. They matter when
 * one appears ORPHANED, which feed fragments do constantly: a body that opens
 * mid-table, or an excerpt cut at `<li>`. Without an entry here they fall
 * through to inline handling and their text welds — `<td>Left</td><td>Right</td>`
 * becoming `LeftRight`, a string that never appeared in the source. Never
 * joining two separate runs of text outranks rendering any particular tag well.
 */
export const LINE_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'dt',
  'dd',
  'figcaption',
  'li',
  'tr',
  'td',
  'th',
]);

/** Inline emphasis tags and the Markdown marker each becomes. */
export const EMPHASIS_MARKERS: Record<string, string> = { em: '*', i: '*', strong: '**', b: '**' };

export const TABLE_TAGS = new Set(['table']);
export const LIST_TAGS = new Set(['ul', 'ol']);
