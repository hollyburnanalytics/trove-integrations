import { defineMcpServer, ToolError, z } from '@ontrove/mcp';

/**
 * Internet Archive — a no-auth hosted MCP server over the public archive.org
 * search and metadata APIs. Only the public, credential-free endpoints are
 * exposed: full-text search (advancedsearch.php) and item metadata
 * (metadata/{identifier}). Login, book-borrowing, and loan endpoints are
 * intentionally omitted because they require user credentials/secrets.
 */

/** A string-or-string-array field as archive.org returns creators/descriptions. */
const StringOrArray = z.union([z.string(), z.array(z.string())]);
/** A string-or-number field as archive.org returns years. */
const StringOrNumber = z.union([z.string(), z.number()]);

/** An `advancedsearch.php` response (lenient — every field defaulted/optional). */
const SearchResponse = z.object({
  response: z
    .object({
      docs: z
        .array(
          z.object({
            identifier: z.string().nullish(),
            title: z.string().nullish(),
            creator: StringOrArray.nullish(),
            year: StringOrNumber.nullish(),
            mediatype: z.string().nullish(),
          }),
        )
        .default([]),
    })
    .nullish(),
});

/** A `metadata/{identifier}` response (lenient — every field defaulted/optional). */
const MetadataResponse = z.object({
  metadata: z
    .object({
      title: z.string().nullish(),
      creator: StringOrArray.nullish(),
      year: StringOrNumber.nullish(),
      date: z.string().nullish(),
      description: StringOrArray.nullish(),
      mediatype: z.string().nullish(),
    })
    .nullish(),
  files: z
    .array(
      z.object({
        name: z.string().nullish(),
        format: z.string().nullish(),
        size: z.string().nullish(),
      }),
    )
    .default([]),
});

/** Collapse a string-or-array field into a single comma-joined string. */
function joinField(value: string | string[] | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.filter(Boolean).join(', ') : value;
}

/** Normalize a year/date value to a 4-digit year string when possible. */
function normalizeYear(value: string | number | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = String(value);
  const match = str.match(/\d{4}/);
  return match ? match[0] : str || undefined;
}

export default defineMcpServer({
  tools: [
    {
      name: 'search_archive',
      title: 'Internet Archive: Search',
      description:
        'Full-text search across public Internet Archive items (archive.org). ' +
        'Optionally filter by mediatype (e.g. texts, movies, audio, image, software) ' +
        "to narrow results. Use for questions like 'find public-domain films about trains' " +
        "or 'books by Jules Verne'. Returns identifiers you can pass to get_item.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z.string().min(1).describe('Search query, e.g. "jules verne" or "moon landing".'),
        mediatype: z
          .enum(['texts', 'movies', 'audio', 'image', 'software', 'data', 'web'])
          .optional()
          .describe(
            'Optional mediatype filter. Common values: texts, movies, audio, image, software.',
          ),
        rows: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of results to return (1–50). Defaults to 10.'),
        page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(1)
          .describe('Result page (1-based). Defaults to 1.'),
      }),
      output: z.object({
        count: z.number(),
        page: z.number(),
        results: z.array(
          z.object({
            identifier: z.string(),
            title: z.string(),
            creator: z.string().optional(),
            year: z.string().optional(),
            mediatype: z.string().optional(),
            itemUrl: z.string(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, mediatype, rows, page } = args;

        const q = mediatype ? `${query} AND mediatype:${mediatype}` : query;
        const params = new URLSearchParams({
          q,
          output: 'json',
          rows: String(rows),
          page: String(page),
        });
        for (const f of ['identifier', 'title', 'creator', 'year', 'mediatype']) {
          params.append('fl[]', f);
        }

        const url = `https://archive.org/advancedsearch.php?${params.toString()}`;
        ctx.log('search_archive querying Internet Archive', { q, rows, page });

        const body = await ctx.fetchJson(url, {
          schema: SearchResponse,
          init: { headers: { accept: 'application/json' } },
          errorMap: (res) =>
            res.status === 400
              ? new ToolError('Internet Archive rejected the search query.', { retryable: false })
              : new ToolError('Internet Archive search is temporarily unavailable.', {
                  retryable: true,
                }),
        });

        const docs = (body.response?.docs ?? []).filter(
          (d): d is typeof d & { identifier: string } => typeof d.identifier === 'string',
        );

        const results = docs.map((d) => ({
          identifier: d.identifier,
          title: d.title ?? d.identifier,
          creator: joinField(d.creator),
          year: normalizeYear(d.year),
          mediatype: d.mediatype ?? undefined,
          itemUrl: `https://archive.org/details/${d.identifier}`,
        }));

        if (results.length === 0) {
          return {
            text: `No Internet Archive items found for "${query}"${
              mediatype ? ` (mediatype:${mediatype})` : ''
            }.`,
            structured: { count: 0, page, results: [] },
          };
        }

        const lines = results
          .slice(0, 10)
          .map((r) => {
            const meta = [r.creator, r.year, r.mediatype].filter(Boolean).join(' · ');
            return `  ${r.title}${meta ? ` — ${meta}` : ''} [${r.identifier}]`;
          })
          .join('\n');

        return {
          text: `${results.length} Internet Archive item(s) for "${query}" (page ${page}):\n${lines}`,
          structured: { count: results.length, page, results },
        };
      },
    },
    {
      name: 'get_item',
      title: 'Internet Archive: Get item',
      description:
        'Fetch metadata for a single public Internet Archive item by its identifier ' +
        '(from search_archive results). Returns title, creator, year, description, ' +
        'mediatype, and a few notable files with direct download URLs.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        identifier: z.string().min(1).describe('The item identifier, e.g. "TheGreatTrainRobbery".'),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(5)
          .describe('Maximum number of notable files to list (1–25). Defaults to 5.'),
      }),
      output: z.object({
        identifier: z.string(),
        title: z.string(),
        creator: z.string().optional(),
        year: z.string().optional(),
        mediatype: z.string().optional(),
        description: z.string().optional(),
        itemUrl: z.string(),
        files: z.array(
          z.object({
            name: z.string(),
            format: z.string().optional(),
            downloadUrl: z.string(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { identifier, maxFiles } = args;

        const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
        ctx.log('get_item querying Internet Archive metadata', { identifier });

        const body = await ctx.fetchJson(url, {
          schema: MetadataResponse,
          init: { headers: { accept: 'application/json' } },
          errorMap: (res) =>
            res.status === 404
              ? new ToolError(`No Internet Archive item found for identifier "${identifier}".`, {
                  retryable: false,
                })
              : new ToolError('Internet Archive metadata is temporarily unavailable.', {
                  retryable: true,
                }),
        });

        const meta = body.metadata;
        // The metadata API returns an empty object (no `metadata` key) for
        // unknown identifiers rather than a 404.
        if (!meta) {
          throw new ToolError(`No Internet Archive item found for identifier "${identifier}".`, {
            retryable: false,
          });
        }

        const description = joinField(meta.description);
        // Surface "notable" media files (skip archive bookkeeping like
        // checksums and derivative metadata) with direct download URLs.
        const skipFormats = new Set([
          'Metadata',
          'JSON',
          'Archive BitTorrent',
          'Item Tile',
          'Item Image',
          'Log',
          'Web ARChive GZ',
        ]);
        const files = (body.files ?? [])
          .filter((f) => typeof f.name === 'string' && f.name.length > 0)
          .filter((f) => !f.format || !skipFormats.has(f.format))
          .slice(0, maxFiles)
          .map((f) => ({
            name: f.name as string,
            format: f.format ?? undefined,
            downloadUrl: `https://archive.org/download/${identifier}/${(f.name as string)
              .split('/')
              .map((seg) => encodeURIComponent(seg))
              .join('/')}`,
          }));

        const title = meta.title ?? identifier;
        const creator = joinField(meta.creator);
        const year = normalizeYear(meta.year ?? meta.date);
        const itemUrl = `https://archive.org/details/${identifier}`;

        const headerLines = [
          title,
          [creator, year, meta.mediatype].filter(Boolean).join(' · '),
          itemUrl,
        ].filter(Boolean);
        const descLine = description ? `\n\n${description.slice(0, 500)}` : '';
        const fileLines =
          files.length > 0
            ? `\n\nFiles:\n${files
                .map((f) => `  ${f.name}${f.format ? ` (${f.format})` : ''} — ${f.downloadUrl}`)
                .join('\n')}`
            : '';

        return {
          text: headerLines.join('\n') + descLine + fileLines,
          structured: {
            identifier,
            title,
            creator,
            year,
            mediatype: meta.mediatype ?? undefined,
            description,
            itemUrl,
            files,
          },
        };
      },
    },
  ],
});
