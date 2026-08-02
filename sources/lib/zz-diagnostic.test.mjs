/** TEMPORARY diagnostic — remove once the Linux/macOS href difference is known. */
import { describe, it } from 'bun:test';
import { parse } from 'node-html-parser';
import { htmlToText } from './html-markdown.mjs';

describe('DIAGNOSTIC href decoding', () => {
  it('reports what the parser does with an entity-encoded href', () => {
    const html = 'See <a href="https:&#x2F;&#x2F;example.com&#x2F;archive">the archive</a> ok';
    const anchor = parse(html).querySelector('a');
    console.log('DIAG platform :', process.platform);
    console.log('DIAG getAttr  :', JSON.stringify(anchor.getAttribute('href')));
    console.log('DIAG rawAttrs :', JSON.stringify(anchor.rawAttrs));
    console.log('DIAG attrs    :', JSON.stringify(anchor.attributes));
    console.log('DIAG output   :', JSON.stringify(htmlToText(html)));
  });
});
