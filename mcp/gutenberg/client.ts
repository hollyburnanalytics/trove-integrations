import { type ToolContext, ToolError } from '@ontrove/mcp';

/**
 * Shared Project Gutenberg plumbing for the gutenberg server modules: the API
 * endpoints, the Gutendex error mapping, the normalised {@link Book} record and
 * its parsers, and the plain-text body fetch (fast Waterloo mirror first, with
 * gutenberg.org fallbacks) that strips the license header/footer.
 */

/** Gutendex metadata API. */
export const GUTENDEX = 'https://gutendex.com';
/**
 * Plain-text book bodies are fetched from the University of Waterloo CS Club
 * Project Gutenberg mirror — it is ~10× faster than gutenberg.org's own origin
 * (which serves a 1 MB book in ~10 s, blowing the gateway wall-clock), keeping
 * even large books well inside budget. gutenberg.org is kept as a fallback.
 */
const PG_MIRROR = 'https://mirror.csclub.uwaterloo.ca/gutenberg';
/** Project Gutenberg origin (slow; used only as a fallback for the text body). */
const GUTENBERG = 'https://www.gutenberg.org';

/** Hard cap on a single text body we will pull into the runtime (~6 MB). */
const MAX_TEXT_BYTES = 6_000_000;

/**
 * Map a non-2xx Gutendex response: a 404 is a missing book id (non-retryable);
 * anything else is a transient outage. Preserves the prior helper's messages.
 */
export const gutendexErrorMap = (res: Response): ToolError =>
  res.status === 404
    ? new ToolError('No such Gutenberg book id.', { retryable: false })
    : new ToolError('Project Gutenberg is temporarily unavailable.', { retryable: true });

/** A normalised Gutenberg book record. */
export interface Book {
  id: number;
  title: string;
  authors: { name: string; birthYear: number | null; deathYear: number | null }[];
  translators: string[];
  editors: string[];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  summary: string | null;
  downloadCount: number | null;
  textUrl: string | null;
  htmlUrl: string | null;
  epubUrl: string | null;
}

/** Person records with life years (birth/death), from a Gutendex people array. */
function personDetails(
  value: unknown,
): { name: string; birthYear: number | null; deathYear: number | null }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((a) => {
      const o = (a ?? {}) as { name?: unknown; birth_year?: unknown; death_year?: unknown };
      return {
        name: typeof o.name === 'string' ? o.name : '',
        birthYear: typeof o.birth_year === 'number' ? o.birth_year : null,
        deathYear: typeof o.death_year === 'number' ? o.death_year : null,
      };
    })
    .filter((p) => p.name.length > 0);
}

/** Filter an unknown value down to an array of strings. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
}

/** Pick the best plain-text download URL from a Gutendex `formats` map. */
function textFormat(formats: Record<string, unknown>): string | null {
  // Prefer UTF-8 plain text; never the zipped `application/octet-stream`.
  for (const [mime, url] of Object.entries(formats)) {
    if (mime.startsWith('text/plain') && typeof url === 'string' && !url.endsWith('.zip'))
      return url;
  }
  return null;
}

/** Map a raw Gutendex book object to a normalised {@link Book}. */
export function toBook(raw: Record<string, unknown>): Book {
  const formats = (raw.formats ?? {}) as Record<string, unknown>;
  const htmlUrl =
    typeof formats['text/html'] === 'string' ? (formats['text/html'] as string) : null;
  const epubUrl =
    typeof formats['application/epub+zip'] === 'string'
      ? (formats['application/epub+zip'] as string)
      : null;
  const summaries = stringArray(raw.summaries);
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    title: typeof raw.title === 'string' ? raw.title : 'Untitled',
    authors: personDetails(raw.authors),
    translators: personDetails(raw.translators).map((p) => p.name),
    editors: personDetails(raw.editors).map((p) => p.name),
    subjects: stringArray(raw.subjects),
    bookshelves: stringArray(raw.bookshelves),
    languages: stringArray(raw.languages),
    summary: summaries[0] ?? null,
    downloadCount: typeof raw.download_count === 'number' ? raw.download_count : null,
    textUrl: textFormat(formats),
    htmlUrl,
    epubUrl,
  };
}

/** Fetch a Gutendex book record by id (throws ToolError on 404 / outage). */
export async function fetchBook(id: number, ctx: ToolContext): Promise<Book> {
  const raw = (await ctx.fetchJson(`${GUTENDEX}/books/${id}`, {
    errorMap: gutendexErrorMap,
  })) as Record<string, unknown>;
  return toBook(raw);
}

/**
 * Build the Waterloo-mirror path for a book's UTF-8 text. The mirror lays books
 * out with every digit-but-the-last as a directory (single-digit ids under
 * `0/`), then the id, then `{id}-0.txt`: e.g. 84 → `8/84/84-0.txt`,
 * 2701 → `2/7/0/2701/2701-0.txt`, 3 → `0/3/3-0.txt`.
 */
function mirrorTextUrl(id: number): string {
  const s = String(id);
  const dirs = s.length === 1 ? ['0'] : s.slice(0, -1).split('');
  return `${PG_MIRROR}/${dirs.join('/')}/${s}/${s}-0.txt`;
}

/** Whether a Gutendex text URL is on the declared host and not the redirecting form. */
function isHostedGutenbergText(url: string): boolean {
  return url.startsWith(`${GUTENBERG}/`) && !url.endsWith('.txt.utf-8');
}

/**
 * Fetch a book's plain-text body and strip the Project Gutenberg license
 * header/footer, returning just the work itself. Returns null if no plain-text
 * edition can be retrieved.
 *
 * Source order: the fast Waterloo mirror's UTF-8 `-0.txt`, then gutenberg.org's
 * canonical cache (`pg{id}.txt`), then any non-redirecting Gutendex text URL.
 * (The Gutendex `.txt.utf-8` URL is skipped: it 301-redirects and the egress
 * proxy does not follow cross-request redirects.)
 */
export async function fetchBookText(book: Book, ctx: ToolContext): Promise<string | null> {
  const candidates = [
    mirrorTextUrl(book.id),
    `${GUTENBERG}/cache/epub/${book.id}/pg${book.id}.txt`,
  ];
  // Only fall back to the Gutendex-supplied URL if it stays on the declared
  // gutenberg.org host (and isn't the redirecting `.txt.utf-8` form), so a
  // mirror URL from Gutendex can never escape the egress allowlist.
  const { textUrl } = book;
  if (textUrl && isHostedGutenbergText(textUrl)) {
    candidates.push(textUrl);
  }
  let res: Response | null = null;
  let transientFailure = false;
  for (const url of candidates) {
    try {
      const r = await ctx.fetch(url);
      if (r.ok) {
        res = r;
        break;
      }
      // A 5xx is a source problem (retryable); a 404 just means this source
      // lacks the file, so fall through to the next candidate.
      if (r.status >= 500) transientFailure = true;
    } catch {
      transientFailure = true;
    }
  }
  if (!res) {
    if (transientFailure) {
      throw new ToolError('Gutenberg text is temporarily unavailable.', { retryable: true });
    }
    return null; // No plain-text edition retrievable from any source.
  }
  const raw = await res.text();
  const text = raw.length > MAX_TEXT_BYTES ? raw.slice(0, MAX_TEXT_BYTES) : raw;
  const start = text.match(/\*\*\* START OF THE PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const end = text.match(/\*\*\* END OF THE PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
  const from = start?.index !== undefined ? start.index + start[0].length : 0;
  const to = end?.index ?? text.length;
  return text.slice(from, to).trim();
}
