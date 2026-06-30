import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * HathiTrust — a no-auth hosted MCP server over the public HathiTrust
 * Bibliographic API (catalog.hathitrust.org/api). HathiTrust is a ~18-million-
 * volume digital library; this API reports, for a given book identifier,
 * whether HathiTrust has digitised it, the catalog record(s), and — per
 * digitised copy — its access rights ("Full view" public-domain vs "Limited
 * (search-only)" in-copyright) and a reading URL.
 *
 * One read-only surface, `lookup_volume`: resolve a book by ISBN / OCLC / LCCN /
 * HathiTrust id and report holdings + rights. Good for "is this book in
 * HathiTrust and can I read it in full, or only search inside it?".
 *
 * Note: HathiTrust gates corpus-wide full-text *search* (it 403s automated
 * clients and requires partner credentials), so this server covers the public
 * bibliographic/rights surface only — not full-text search.
 */

/** HathiTrust catalog / Bibliographic API host. */
const BASE_URL = 'https://catalog.hathitrust.org';

/** A HathiTrust catalog record (one bibliographic entry). */
interface Record_ {
  recordURL: string | null;
  title: string | null;
  isbns: string[];
  oclcs: string[];
  lccns: string[];
  publishDates: string[];
}

/** One digitised copy held by HathiTrust. */
interface Item {
  htid: string | null;
  source: string | null;
  rightsCode: string | null;
  rights: string | null;
  fullView: boolean;
  url: string | null;
}

/** Coerce an unknown value to a string array. */
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/** First string of an array, or null. */
function first(value: unknown): string | null {
  const arr = strArray(value);
  return arr[0] ?? null;
}

/** Read an optional string field, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'lookup_volume',
      title: 'HathiTrust: Look up a volume',
      description:
        'Look up a book in HathiTrust by ISBN, OCLC number, LCCN, or HathiTrust id ' +
        '(htid). Reports whether HathiTrust holds a digitised copy, the catalog ' +
        'record(s) (title, identifiers, publish dates), and — per copy — its access ' +
        'rights (Full view = readable public domain, with a reading URL, vs Limited = ' +
        'search-only, in copyright). Answers "is this book digitised in HathiTrust and ' +
        'can I read it in full?". Provide exactly one identifier. This is an exact-match ' +
        "lookup against the identifiers on HathiTrust's catalog record: an htid (names a " +
        'specific scanned copy) is the most reliable, and ISBN works well for modern ' +
        'books; an arbitrary edition\'s OCLC/LCCN may report "not found" even when the ' +
        'work is held under a different record. It does not do full-text or title search.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        isbn: z.string().optional().describe('ISBN-10 or ISBN-13.'),
        oclc: z.string().optional().describe('OCLC (WorldCat) number.'),
        lccn: z.string().optional().describe('Library of Congress Control Number.'),
        htid: z.string().optional().describe('HathiTrust volume id, e.g. "mdp.39015025315527".'),
      }),
      output: z.object({
        identifier: z.string(),
        found: z.boolean(),
        catalogUrl: z.string().nullable(),
        records: z.array(
          z.object({
            recordURL: z.string().nullable(),
            title: z.string().nullable(),
            isbns: z.array(z.string()),
            oclcs: z.array(z.string()),
            lccns: z.array(z.string()),
            publishDates: z.array(z.string()),
          }),
        ),
        items: z.array(
          z.object({
            htid: z.string().nullable(),
            source: z.string().nullable(),
            rightsCode: z.string().nullable(),
            rights: z.string().nullable(),
            fullView: z.boolean(),
            url: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { isbn, oclc, lccn, htid } = args;
        const provided = [
          ['isbn', isbn],
          ['oclc', oclc],
          ['lccn', lccn],
          ['htid', htid],
        ].filter(([, v]) => typeof v === 'string' && v.length > 0) as [string, string][];
        const only = provided[0];
        if (provided.length !== 1 || !only) {
          throw new ToolError('Provide exactly one of isbn, oclc, lccn, or htid.', {
            retryable: false,
          });
        }
        const [idType, rawId] = only;
        // HathiTrust ids carry meaningful punctuation (htid arks contain ":" and
        // "/", which the API path requires literally — they must NOT be percent-
        // encoded), so sanitise per type rather than URL-encoding the whole key.
        const idValue =
          idType === 'isbn'
            ? rawId.replace(/[^0-9Xx]/g, '')
            : idType === 'htid'
              ? rawId.trim().replace(/[^A-Za-z0-9.:/_-]/g, '')
              : rawId.trim().replace(/[^A-Za-z0-9-]/g, '');
        const key = `${idType}:${idValue}`;
        ctx.log('lookup_volume', { key });

        const body = (await ctx.fetchJson(`${BASE_URL}/api/volumes/brief/json/${key}`, {
          errorMap: (res) =>
            res.status === 400 || res.status === 404
              ? new ToolError(`HathiTrust rejected the identifier "${key}".`, { retryable: false })
              : new ToolError('HathiTrust is temporarily unavailable.', { retryable: true }),
        })) as Record<string, unknown> | null;
        const entry = (body?.[key] ?? null) as { records?: unknown; items?: unknown } | null;

        const recordsObj = (entry?.records ?? {}) as Record<string, unknown>;
        const records: Record_[] = Object.values(recordsObj).map((r) => {
          const o = r as Record<string, unknown>;
          return {
            recordURL: str(o.recordURL),
            title: first(o.titles),
            isbns: strArray(o.isbns),
            oclcs: strArray(o.oclcs),
            lccns: strArray(o.lccns),
            publishDates: strArray(o.publishDates),
          };
        });
        const items: Item[] = (Array.isArray(entry?.items) ? entry.items : []).map((i) => {
          const o = i as Record<string, unknown>;
          const code = str(o.rightsCode);
          // HathiTrust rights codes beginning "pd" (pd, pdus, ...) are public
          // domain → readable in full; everything else is limited/search-only.
          const fullView = code !== null && /^pd/i.test(code);
          return {
            htid: str(o.htid),
            source: str(o.orig),
            rightsCode: code,
            rights: str(o.usRightsString),
            fullView,
            url: str(o.itemURL),
          };
        });

        const found = records.length > 0 || items.length > 0;
        const catalogUrl = records[0]?.recordURL ?? null;
        if (!found) {
          return {
            text: `HathiTrust has no digitised copy for ${key}.`,
            structured: { identifier: key, found: false, catalogUrl: null, records: [], items: [] },
          };
        }
        const title = records[0]?.title ?? '(untitled record)';
        const readable = items.filter((i) => i.fullView).length;
        const itemLines = items
          .slice(0, 8)
          .map(
            (i) =>
              `  ${i.fullView ? '📖 Full view' : '🔒 Search-only'} — ${i.source ?? '?'} (${i.htid ?? '?'})`,
          )
          .join('\n');
        return {
          text:
            `"${title}" — HathiTrust has ${items.length} digitised cop${items.length === 1 ? 'y' : 'ies'} ` +
            `(${readable} full-view, ${items.length - readable} search-only).\n${itemLines}`,
          structured: { identifier: key, found: true, catalogUrl, records, items },
        };
      },
    },
  ],
});
