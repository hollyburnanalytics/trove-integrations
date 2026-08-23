/**
 * Regression tests for the HTML → Markdown converter.
 *
 * **Every case here was found by running the converter over a real corpus** —
 * 502 public feeds, 35,253 article bodies, each result pushed through the
 * backend's own ingest gate. None came from imagining what might break. The
 * counts in the comments are how many bodies in that corpus hit each defect, and
 * they are the argument for the test: a shape that occurs 2,417 times is not an
 * edge case, it is the corpus.
 *
 * The fixture-based tests that preceded these passed throughout, which is the
 * point — a converter can only be as good as the inputs it has been shown, and
 * eight hand-written fixtures agree with whatever the code already does.
 */

import { describe, expect, it } from 'vitest';
import { htmlToText } from './html-markdown.ts';

describe('htmlToText — list structure', () => {
  it('KEEPS ordered-list numbering, which 239 of 246 corpus lists lost', () => {
    // Every `<ol>` used to render as `-` bullets. A numbered procedure and an
    // unordered set of options are different documents, and once the numbers are
    // gone nothing downstream can tell which one it was holding.
    expect(htmlToText('<ol><li>First</li><li>Second</li></ol>')).toBe('1. First\n2. Second');
  });

  it('honours a list `start` attribute rather than restarting at one', () => {
    expect(htmlToText('<ol start="4"><li>Fourth</li><li>Fifth</li></ol>')).toBe(
      '4. Fourth\n5. Fifth',
    );
  });

  it('INDENTS a nested list, which 2,417 corpus bodies had flattened', () => {
    expect(htmlToText('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>')).toContain('  - Inner');
  });

  it('skips an EMPTY list item rather than emitting a bare marker', () => {
    // The Guardian ships empty `<li>` as spacing; 299 corpus bodies carried one.
    expect(htmlToText('<ul><li>Real</li><li></li><li>Also real</li></ul>')).toBe(
      '- Real\n- Also real',
    );
  });

  it('finds items through a WRAPPER, which otherwise loses the list entirely', () => {
    // Scanning only direct children looks right and fails silently: a `<ul>`
    // whose items sit inside a `<div>` rendered as the empty string, because the
    // wrapper was not an `<li>` and was skipped whole. Silent total loss is the
    // worst failure shape available to a converter.
    expect(htmlToText('<ul><div><li>Alpha</li><li>Beta</li></div></ul>')).toBe('- Alpha\n- Beta');
  });

  it('does not pull a NESTED list up into its parent', () => {
    const markdown = htmlToText('<ul><li>Outer<ul><li>Inner</li></ul></li></ul>');
    expect(markdown.match(/Inner/g)).toHaveLength(1);
  });

  it('aligns a continuation line under its marker, so the list does not end early', () => {
    const markdown = htmlToText('<ul><li>Line<br>Wrapped</li></ul>');
    expect(markdown).toBe('- Line\n  Wrapped');
  });
});

describe('htmlToText — tables', () => {
  it('never WELDS two cells into a word that was not in the source', () => {
    // `<td>Launch date</td><td>September 2026</td>` arrived as
    // `Launch dateSeptember 2026` — not a formatting loss but a fabricated
    // string. 21 corpus bodies did this.
    const markdown = htmlToText(
      '<table><tr><td>Launch date</td><td>September 2026</td></tr></table>',
    );
    expect(markdown).not.toContain('Launch dateSeptember');
    expect(markdown).toContain('| Launch date | September 2026 |');
  });

  it('emits a GFM table with a divider row', () => {
    expect(
      htmlToText('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'),
    ).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('pads a RAGGED row instead of letting the column count drift', () => {
    const markdown = htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>');
    expect(markdown.split('\n').at(-1)).toBe('| c |   |');
  });

  it('escapes a pipe inside a cell, which would otherwise open a column', () => {
    expect(htmlToText('<table><tr><td>a|b</td></tr></table>')).toContain(String.raw`a\|b`);
  });

  it('does not pull a NESTED table up into its parent', () => {
    // `querySelectorAll` is unscoped, so a table asking for its rows gets the
    // rows of every table inside it too — and the inner cells were rendered
    // twice, once in the outer grid and once inside the cell containing them.
    const markdown = htmlToText(
      '<table><tr><td>OUTER<table><tr><td>INNER</td></tr></table></td></tr></table>',
    );
    expect(markdown).toBe('| OUTER INNER |\n| --- |');
  });
});

describe('htmlToText — text that looks like markup', () => {
  it('escapes a line-leading `#` so prose does not become a heading', () => {
    expect(htmlToText('<p># not a heading</p>')).toBe(String.raw`\# not a heading`);
  });

  it('leaves a mid-sentence `#` alone, because position is what matters', () => {
    expect(htmlToText('<p>issue #42 is open</p>')).toBe('issue #42 is open');
  });

  it('escapes a line-leading `>` so prose does not become a quotation', () => {
    expect(htmlToText('<p>&gt; not a quote</p>')).toBe(String.raw`\> not a quote`);
  });

  it('escapes brackets so prose is not read as a link', () => {
    expect(htmlToText('<p>See [label](http://x) verbatim</p>')).toBe(
      String.raw`See \[label\](http://x) verbatim`,
    );
  });
});

describe('htmlToText — inline contexts that cannot hold blocks', () => {
  it('FLATTENS a heading inside a link, rather than emitting `[#### Title]`', () => {
    // 77 corpus bodies wrap an `<h4>` in an `<a>`. Emitted literally it parses
    // as a link whose text starts with hashes — not a heading, and unfixable
    // downstream.
    expect(htmlToText('<a href="https://x.test/a"><h4>Big</h4></a>')).toBe(
      '[Big](https://x.test/a)',
    );
  });

  it('collapses a `<br>` inside a link, which would split `[` from `]`', () => {
    expect(htmlToText('<a href="https://x.test/a">line<br>two</a>')).toBe(
      '[line two](https://x.test/a)',
    );
  });
});

describe('htmlToText — code', () => {
  it('WIDENS a code span past any backtick inside it', () => {
    // 621 corpus bodies contain a backtick inside code — JavaScript template
    // literals, mostly — and a fixed single backtick closed the span early,
    // dropping the rest of the line into prose.
    expect(htmlToText('<code>a ` b</code>')).toBe('``a ` b``');
  });

  it('pads a span whose content starts or ends with a backtick', () => {
    expect(htmlToText('<code>`x`</code>')).toBe('`` `x` ``');
  });

  it('widens a FENCE past a fence shown inside the sample', () => {
    expect(htmlToText('<pre>```\nnested\n```</pre>')).toBe('````\n```\nnested\n```\n````');
  });
});

describe('htmlToText — hostile or malformed input', () => {
  it('unwraps a CDATA section that arrived as literal text', () => {
    // 179 of 239 corpus gate rejections were this one shape, each holding a
    // feed's cursor.
    expect(htmlToText('<![CDATA[<p>Real text.</p>]]>')).toBe('Real text.');
  });

  it('decodes DOUBLE-encoded markup rather than storing it as raw HTML', () => {
    // `&amp;lt;img …` survives one decode as `&lt;img …`, which contains no `<`
    // and so reads as plain prose — and lands in the corpus as literal markup.
    expect(htmlToText('&amp;lt;p&amp;gt;Hello&amp;lt;/p&amp;gt;')).toBe('Hello');
  });

  it('drops a `javascript:` destination to its text', () => {
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  it('drops a `data:` destination, which smuggles a payload into the body', () => {
    expect(htmlToText('<a href="data:text/html,x">label</a>')).toBe('label');
  });

  it('keeps an ordinary relative destination', () => {
    expect(htmlToText('<a href="/about">About</a>')).toBe('[About](/about)');
  });

  it('strips zero-width and control characters', () => {
    const zeroWidth = String.fromCodePoint(8203);
    const softHyphen = String.fromCodePoint(173);
    expect(htmlToText(`<p>clean${zeroWidth}${softHyphen} text</p>`)).toBe('clean text');
  });

  it('MERGES adjacent emphasis instead of fabricating literal asterisks', () => {
    // `**a****b**` is not two bold runs: it reads as bold text containing four
    // asterisks, which the gate then writes back into the prose as `\*\*\*\*`.
    expect(htmlToText('<strong>a</strong><strong>b</strong>')).toBe('**ab**');
  });

  it('leaves SEPARATED emphasis as two spans', () => {
    expect(htmlToText('<strong>a</strong> <strong>b</strong>')).toBe('**a** **b**');
  });

  it('does not let a pretty-printed source indent a line into a code block', () => {
    // Whitespace between tags is one text node each, collapsing to one space
    // apiece; a source indented for humans opened lines at column ten, and four
    // leading spaces are an indented code block. 65 corpus bodies fenced a photo
    // caption as source code this way.
    const pretty =
      '<figure>\n      <picture>\n        </picture>\n        <img alt="A caption">\n</figure>';
    expect(htmlToText(pretty)).toBe('[Image: A caption]');
  });

  it('never WELDS an orphaned row, cell or item into one word', () => {
    // Feed fragments open mid-structure constantly — an excerpt cut at `<li>`, a
    // body that starts inside a table. With no line boundary these fall through
    // to inline handling and `<td>Left</td><td>Right</td>` becomes `LeftRight`,
    // a string that never appeared in the source.
    expect(htmlToText('<td>Left</td><td>Right</td>')).not.toContain('LeftRight');
    expect(htmlToText('<li>One</li><li>Two</li>')).not.toContain('OneTwo');
    expect(htmlToText('<tr><td>Aaa</td><td>Bbb</td></tr>')).not.toContain('AaaBbb');
  });

  it('survives deep nesting without throwing', () => {
    expect(htmlToText(`${'<div>'.repeat(60)}deep${'</div>'.repeat(60)}`)).toBe('deep');
  });

  it('returns empty for whitespace-only and empty input', () => {
    expect(htmlToText('   \n\t  ')).toBe('');
    expect(htmlToText('')).toBe('');
  });
});
