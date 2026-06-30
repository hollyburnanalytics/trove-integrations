import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';

/**
 * Project Gutenberg — a no-auth hosted MCP server over the freely-licensed
 * Project Gutenberg corpus of ~75,000 public-domain books. Metadata comes from
 * the Gutendex JSON API (gutendex.com); full text is fetched from gutenberg.org.
 *
 * Four read-only surfaces:
 *  - `search_books`  — find public-domain books by keyword / topic / language,
 *  - `get_book`      — metadata + download formats for one book,
 *  - `search_inside` — full-text search *within* a book, returning matching
 *    passages with surrounding context (legal: the text is public domain), and
 *  - `get_excerpt`   — read a windowed slice of a book's text by offset.
 *
 * No API key. Everything Gutenberg distributes is out of copyright, so fetching
 * and searching the full text is unrestricted.
 */

/** Gutendex metadata API. */
const GUTENDEX = 'https://gutendex.com';
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
const gutendexErrorMap = (res: Response): ToolError =>
  res.status === 404
    ? new ToolError('No such Gutenberg book id.', { retryable: false })
    : new ToolError('Project Gutenberg is temporarily unavailable.', { retryable: true });

/** A normalised Gutenberg book record. */
interface Book {
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

/** Render a Gutendex year, marking BCE for negatives: 180 → "180", -428 → "428 BCE". */
function formatYear(year: number | null): string {
  if (year === null) return '?';
  return year < 0 ? `${-year} BCE` : String(year);
}

/** Format an author with life years, e.g. `Marcus Aurelius (121–180)`, `Plato (428 BCE–348 BCE)`. */
function authorLabel(a: {
  name: string;
  birthYear: number | null;
  deathYear: number | null;
}): string {
  if (a.birthYear === null && a.deathYear === null) return a.name;
  return `${a.name} (${formatYear(a.birthYear)}–${formatYear(a.deathYear)})`;
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
function toBook(raw: Record<string, unknown>): Book {
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
async function fetchBook(id: number, ctx: ToolContext): Promise<Book> {
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
async function fetchBookText(book: Book, ctx: ToolContext): Promise<string | null> {
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

/**
 * Smart-punctuation variants — curly quotes, apostrophes, and the dash family —
 * grouped under the plain ASCII character they stand in for, so a quotation typed
 * on a keyboard matches a typeset source. Keyed by ASCII char → its variants.
 */
const SMART_PUNCTUATION: Record<string, string> = {
  "'": '‘’‚‛′',
  '"': '“”„‟″',
  '-': '‐‑‒–—―',
};

/** Fold one character for search: smart punctuation → ASCII, lower-case, drop diacritics. */
function foldChar(ch: string): string {
  for (const [ascii, variants] of Object.entries(SMART_PUNCTUATION)) {
    if (variants.includes(ch)) return ascii;
  }
  return ch.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Normalise text for forgiving full-text search — case-, accent-, and
 * punctuation-insensitive, with every run of whitespace collapsed to one space so
 * a quotation matches across the source's line breaks. Returns the folded string
 * and a map from each folded character back to its offset in the original text, so
 * a match can be reported — and re-read with get_excerpt — at its true position.
 */
function foldForSearch(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) continue; // the loop bound guarantees this; satisfies noUncheckedIndexedAccess
    if (/\s/.test(ch)) {
      gap = folded.length > 0; // a separating space, emitted lazily before the next visible char
      continue;
    }
    if (gap) {
      folded += ' ';
      map.push(i);
      gap = false;
    }
    for (const c of foldChar(ch)) {
      folded += c;
      map.push(i);
    }
  }
  return { folded, map };
}

/** Build a context snippet around an original-text span, collapsing whitespace. */
function snippetAround(text: string, start: number, end: number, context: number): string {
  const s = Math.max(0, start - context);
  const e = Math.min(text.length, end + context);
  const body = text.slice(s, e).replace(/\s+/g, ' ').trim();
  return `${s > 0 ? '…' : ''}${body}${e < text.length ? '…' : ''}`;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_books',
      title: 'Gutenberg: Search public-domain books',
      description:
        'Search the Project Gutenberg corpus (~75,000 free, public-domain books) ' +
        'by keyword (matches author + title), optional topic/subject, language, and ' +
        'author era; sort by popularity. Returns each book with a description, authors ' +
        '(with life years), subjects, curated bookshelves, popularity, and a bookId to ' +
        'pass to get_book / search_inside / get_excerpt.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .optional()
          .describe('Keywords over author + title, e.g. "shelley frankenstein".'),
        topic: z.string().optional().describe('Subject or bookshelf, e.g. "horror", "philosophy".'),
        language: z.string().optional().describe('Two-letter language code, e.g. "en", "fr".'),
        sort: z
          .enum(['popular', 'ascending', 'descending'])
          .optional()
          .describe(
            'Order results: "popular" (most-downloaded first) or by id ascending/descending.',
          ),
        authorYearStart: z
          .number()
          .int()
          .optional()
          .describe('Only authors alive on/after this year (negative = BCE), e.g. -100.'),
        authorYearEnd: z
          .number()
          .int()
          .optional()
          .describe('Only authors alive on/before this year, e.g. 200.'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max results (1–25).'),
      }),
      output: z.object({
        total: z.number(),
        count: z.number(),
        books: z.array(
          z.object({
            bookId: z.number(),
            title: z.string(),
            authors: z.array(
              z.object({
                name: z.string(),
                birthYear: z.number().nullable(),
                deathYear: z.number().nullable(),
              }),
            ),
            description: z.string().nullable(),
            languages: z.array(z.string()),
            subjects: z.array(z.string()),
            bookshelves: z.array(z.string()),
            downloadCount: z.number().nullable(),
            hasFullText: z.boolean(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, topic, language, sort, authorYearStart, authorYearEnd, limit } = args;
        if (!query && !topic && !language) {
          throw new ToolError('Provide at least one of query, topic, or language.', {
            retryable: false,
          });
        }
        const params = new URLSearchParams();
        if (query) params.set('search', query);
        if (topic) params.set('topic', topic);
        if (language) params.set('languages', language);
        if (sort) params.set('sort', sort);
        if (authorYearStart !== undefined) params.set('author_year_start', String(authorYearStart));
        if (authorYearEnd !== undefined) params.set('author_year_end', String(authorYearEnd));
        ctx.log('search_books', { query, topic, language, sort, limit });
        const body = (await ctx.fetchJson(`${GUTENDEX}/books/?${params}`, {
          errorMap: gutendexErrorMap,
        })) as Record<string, unknown>;
        const results = Array.isArray(body.results) ? body.results : [];
        const books = results.slice(0, limit).map((r) => {
          const b = toBook(r as Record<string, unknown>);
          return {
            bookId: b.id,
            title: b.title,
            authors: b.authors,
            description: b.summary,
            languages: b.languages,
            subjects: b.subjects.slice(0, 6),
            bookshelves: b.bookshelves,
            downloadCount: b.downloadCount,
            hasFullText: b.textUrl !== null,
          };
        });
        const total = typeof body.count === 'number' ? body.count : books.length;
        if (books.length === 0) {
          return {
            text: 'No Gutenberg books matched.',
            structured: { total: 0, count: 0, books: [] },
          };
        }
        const lines = books
          .map(
            (b) =>
              `  [${b.bookId}] "${b.title}"${b.authors.length ? ` — ${b.authors.map(authorLabel).join(', ')}` : ''}` +
              `${b.downloadCount !== null ? ` · ${b.downloadCount} dl` : ''}`,
          )
          .join('\n');
        return {
          text: `${books.length} of ${total} Gutenberg book(s):\n${lines}`,
          structured: { total, count: books.length, books },
        };
      },
    },
    {
      name: 'get_book',
      title: 'Gutenberg: Get book details',
      description:
        'Fetch full metadata for one Project Gutenberg book by bookId: title, authors ' +
        '(with life years), translators/editors, a description, subjects, curated ' +
        'bookshelves, popularity, an estimated word count and reading time, and the ' +
        'plain-text / HTML / EPUB URLs.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        bookId: z.number().int().positive().describe('Gutenberg book id (from search_books).'),
      }),
      output: z.object({
        bookId: z.number(),
        title: z.string(),
        authors: z.array(
          z.object({
            name: z.string(),
            birthYear: z.number().nullable(),
            deathYear: z.number().nullable(),
          }),
        ),
        translators: z.array(z.string()),
        editors: z.array(z.string()),
        description: z.string().nullable(),
        subjects: z.array(z.string()),
        bookshelves: z.array(z.string()),
        languages: z.array(z.string()),
        downloadCount: z.number().nullable(),
        wordCount: z.number().nullable(),
        readingMinutes: z.number().nullable(),
        textUrl: z.string().nullable(),
        htmlUrl: z.string().nullable(),
        epubUrl: z.string().nullable(),
      }),
      async handler(args, ctx) {
        ctx.log('get_book', { bookId: args.bookId });
        const b = await fetchBook(args.bookId, ctx);
        // Length is not in the metadata, so derive it from the body (best-effort:
        // a fetch failure just leaves wordCount/readingMinutes null).
        let wordCount: number | null = null;
        const text = await fetchBookText(b, ctx).catch(() => null);
        if (text) wordCount = text.split(/\s+/).filter(Boolean).length;
        const readingMinutes = wordCount === null ? null : Math.max(1, Math.round(wordCount / 238));
        return {
          text:
            `[${b.id}] "${b.title}"${b.authors.length ? ` — ${b.authors.map(authorLabel).join(', ')}` : ''}\n` +
            `  ${b.languages.join('/') || '?'} · ${b.downloadCount ?? '?'} downloads` +
            `${readingMinutes ? ` · ~${readingMinutes} min read` : ''}` +
            `${b.summary ? `\n  ${b.summary}` : ''}` +
            `${b.bookshelves.length ? `\n  Shelves: ${b.bookshelves.join('; ')}` : ''}` +
            `${b.textUrl ? `\n  Full text: ${b.textUrl}` : ''}`,
          structured: {
            bookId: b.id,
            title: b.title,
            authors: b.authors,
            translators: b.translators,
            editors: b.editors,
            description: b.summary,
            subjects: b.subjects,
            bookshelves: b.bookshelves,
            languages: b.languages,
            downloadCount: b.downloadCount,
            wordCount,
            readingMinutes,
            textUrl: b.textUrl,
            htmlUrl: b.htmlUrl,
            epubUrl: b.epubUrl,
          },
        };
      },
    },
    {
      name: 'search_inside',
      title: 'Gutenberg: Search inside a book',
      description:
        'Full-text search within a single Project Gutenberg book. Matching is case-, ' +
        'accent-, and punctuation-insensitive and reads through line breaks, so a ' +
        'quotation typed from memory still matches the typeset source — while the ' +
        "returned snippets preserve the book's exact wording for citation. Each match " +
        'comes with surrounding context and its character offset (pass the offset to ' +
        'get_excerpt to read more), plus a total match count. Use it to locate or verify ' +
        'a quotation, to check whether a phrase actually appears in a work (e.g. ' +
        '"Elementary, my dear Watson" returns zero matches in the Sherlock Holmes canon), ' +
        'or to gauge how often a term occurs. Substring match, not regex or semantic; ' +
        'license boilerplate excluded.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        bookId: z.number().int().positive().describe('Gutenberg book id (from search_books).'),
        query: z.string().min(2).describe('Text to find inside the book, e.g. "the monster".'),
        maxMatches: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(8)
          .describe('Max passages to return (1–25).'),
        context: z
          .number()
          .int()
          .min(40)
          .max(400)
          .default(160)
          .describe('Context chars each side of a match.'),
      }),
      output: z.object({
        bookId: z.number(),
        title: z.string(),
        query: z.string(),
        totalMatches: z.number(),
        matches: z.array(z.object({ offset: z.number(), snippet: z.string() })),
      }),
      async handler(args, ctx) {
        const { bookId, query, maxMatches, context } = args;
        ctx.log('search_inside', { bookId, query, maxMatches });
        const book = await fetchBook(bookId, ctx);
        const text = await fetchBookText(book, ctx);
        if (text === null) {
          throw new ToolError(`Gutenberg book ${bookId} has no plain-text edition to search.`, {
            retryable: false,
          });
        }
        const { folded, map } = foldForSearch(text);
        const needle = foldForSearch(query).folded;
        const matches: { offset: number; snippet: string }[] = [];
        let total = 0;
        for (
          let at = needle ? folded.indexOf(needle) : -1;
          at !== -1;
          at = folded.indexOf(needle, at + needle.length)
        ) {
          total++;
          if (matches.length < maxMatches) {
            const start = map[at];
            const endIdx = map[at + needle.length - 1];
            // Both indices are in range by construction; the guard satisfies noUncheckedIndexedAccess.
            if (start !== undefined && endIdx !== undefined) {
              matches.push({
                offset: start,
                snippet: snippetAround(text, start, endIdx + 1, context),
              });
            }
          }
        }
        if (total === 0) {
          return {
            text: `No matches for "${query}" in "${book.title}".`,
            structured: { bookId, title: book.title, query, totalMatches: 0, matches: [] },
          };
        }
        const lines = matches.map((m) => `  @${m.offset}: ${m.snippet}`).join('\n');
        return {
          text: `${total} match(es) for "${query}" in "${book.title}" (showing ${matches.length}):\n${lines}`,
          structured: { bookId, title: book.title, query, totalMatches: total, matches },
        };
      },
    },
    {
      name: 'get_excerpt',
      title: 'Gutenberg: Read an excerpt',
      description:
        "Read a windowed slice of a Project Gutenberg book's text by character offset " +
        '(license boilerplate excluded). Offset 0 is the start of the file, which for ' +
        'many books is front matter — title page, contents, illustration lists — before ' +
        'the work itself; use search_inside to jump straight to a passage. Returns the ' +
        'text plus the next offset to continue reading.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        bookId: z.number().int().positive().describe('Gutenberg book id (from search_books).'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Character offset to start at (default 0).'),
        length: z
          .number()
          .int()
          .min(200)
          .max(8000)
          .default(2500)
          .describe('Characters to return (200–8000).'),
      }),
      output: z.object({
        bookId: z.number(),
        title: z.string(),
        offset: z.number(),
        length: z.number(),
        totalLength: z.number(),
        nextOffset: z.number().nullable(),
        text: z.string(),
      }),
      async handler(args, ctx) {
        const { bookId, offset, length } = args;
        ctx.log('get_excerpt', { bookId, offset, length });
        const book = await fetchBook(bookId, ctx);
        const text = await fetchBookText(book, ctx);
        if (text === null) {
          throw new ToolError(`Gutenberg book ${bookId} has no plain-text edition to read.`, {
            retryable: false,
          });
        }
        if (offset >= text.length) {
          throw new ToolError(
            `Offset ${offset} is past the end of the book (${text.length} chars).`,
            {
              retryable: false,
            },
          );
        }
        const end = Math.min(text.length, offset + length);
        const slice = text.slice(offset, end);
        const nextOffset = end < text.length ? end : null;
        return {
          text: slice,
          structured: {
            bookId,
            title: book.title,
            offset,
            length: slice.length,
            totalLength: text.length,
            nextOffset,
          },
        };
      },
    },
  ],
});
