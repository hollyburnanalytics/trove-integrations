/**
 * PDF text extraction for source adapters, via `unpdf` (a serverless-friendly
 * PDF.js build — pure JS, no native binaries, so it runs in the cloud sync
 * runtime as-is). Extraction reads the PDF's text layer; a scanned/image-only
 * document yields little or no text, which callers should treat as "no body"
 * rather than an error.
 */

import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Extract a PDF's text as clean plain text: pages merged in order, whitespace
 * runs collapsed, blank-line runs reduced to paragraph breaks.
 *
 * @param {Uint8Array} bytes - the raw PDF file
 * @returns {Promise<string>} the text layer, or '' when the PDF has none
 */
export async function extractPdfText(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll(/[^\S\n]+/g, ' ')
    .replaceAll(/ ?\n ?/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}
