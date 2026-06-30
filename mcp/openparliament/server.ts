import { defineMcpServer, type ToolContext, ToolError, z } from '@ontrove/mcp';
import { getJson as sharedGetJson } from '../lib/http.ts';

/**
 * OpenParliament (Canada) — a no-auth hosted MCP server over the
 * OpenParliament.ca API, mirroring the Canadian House of Commons.
 *
 * Three read-only surfaces:
 *  - `find_mp` — look up a Member of Parliament by name (party, riding, slug),
 *  - `mp_speeches` — recent Hansard / committee statements BY an MP, and
 *  - `search_bills` — bills, optionally by session.
 *
 * Reality of the API (verified): there is NO JSON full-text search of Hansard
 * (`/search/` is HTML-only and `/speeches/` ignores a free-text query), but
 * `/speeches/?politician=<slug>` filters to one member's statements — so the
 * Hansard surface here is "what has this MP said?", not topic search.
 *
 * No API key, but OpenParliament asks every client to send a descriptive
 * User-Agent with a contact address. Many fields are localized (`{ en, fr }`);
 * {@link loc} resolves the English value.
 */

/** Base host for the OpenParliament API. */
const BASE_URL = 'https://api.openparliament.ca';

/** Descriptive User-Agent (OpenParliament's requested etiquette). Replace with your own contact before deploying. */
const CONTACT_EMAIL = 'trove-integrations@users.noreply.github.com';
const USER_AGENT = `Trove MCP (${CONTACT_EMAIL})`;

/** Resolve a possibly-localized OpenParliament field to its English string. */
function loc(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const en = (value as { en?: unknown }).en;
    if (typeof en === 'string') return en;
  }
  return null;
}

/** Strip HTML tags + collapse whitespace from a Hansard statement body. */
function stripHtml(html: unknown): string | null {
  const text = loc(html);
  if (text === null) return null;
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the trailing slug from an OpenParliament resource URL. */
function slugOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const parts = url.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

/** Build a full openparliament.ca URL from an API relative path. */
function fullUrl(path: unknown): string | null {
  return typeof path === 'string' ? `https://openparliament.ca${path}` : null;
}

/** GET an OpenParliament URL with the requested UA and parse JSON. */
const getJson = (
  url: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
): Promise<Record<string, unknown>> =>
  sharedGetJson(url, ctx, {
    service: 'OpenParliament',
    headers: { 'user-agent': USER_AGENT },
  });

/** The `objects` array of a list response. */
function objects(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.objects) ? (body.objects as Array<Record<string, unknown>>) : [];
}

/**
 * Resolve an MP name (or slug) to a politician slug. A hyphenated lowercase
 * input is treated as a slug; otherwise the current-MP list is fetched and the
 * first name-substring match is used.
 */
async function resolveSlug(
  nameOrSlug: string,
  ctx: Pick<ToolContext, 'fetchJson'>,
): Promise<{ slug: string; name: string } | null> {
  const trimmed = nameOrSlug.trim();
  if (/^[a-z]+(-[a-z]+)+$/.test(trimmed)) return { slug: trimmed, name: trimmed };
  const body = await getJson(`${BASE_URL}/politicians/?format=json&limit=400`, ctx);
  const q = trimmed.toLowerCase();
  for (const o of objects(body)) {
    const name = loc(o.name) ?? '';
    if (name.toLowerCase().includes(q)) {
      const slug = slugOf(o.url);
      if (slug) return { slug, name };
    }
  }
  return null;
}

export default defineMcpServer({
  tools: [
    {
      name: 'find_mp',
      title: 'Parliament: Find MP',
      description:
        'Look up a current Member of Parliament by name. Returns their party, ' +
        'riding/constituency, province, and slug (pass the slug or name to ' +
        'mp_speeches).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        name: z.string().min(1).describe('MP name (or part of it), e.g. "Freeland".'),
        limit: z.number().int().min(1).max(20).default(10).describe('Max matches (1–20).'),
      }),
      output: z.object({
        query: z.string(),
        count: z.number(),
        members: z.array(
          z.object({
            name: z.string(),
            slug: z.string().nullable(),
            party: z.string().nullable(),
            riding: z.string().nullable(),
            province: z.string().nullable(),
            url: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { name, limit } = args;
        ctx.log('find_mp', { name, limit });
        const body = await getJson(`${BASE_URL}/politicians/?format=json&limit=400`, ctx);
        const q = name.toLowerCase();
        const members = objects(body)
          .filter((o) => (loc(o.name) ?? '').toLowerCase().includes(q))
          .slice(0, limit)
          .map((o) => {
            const party = (o.current_party ?? {}) as Record<string, unknown>;
            const riding = (o.current_riding ?? {}) as Record<string, unknown>;
            return {
              name: loc(o.name) ?? '',
              slug: slugOf(o.url),
              party: loc(party.short_name),
              riding: loc(riding.name),
              province: typeof riding.province === 'string' ? riding.province : null,
              url: fullUrl(o.url),
            };
          });
        if (members.length === 0) {
          return {
            text: `No current MP matching "${name}".`,
            structured: { query: name, count: 0, members: [] },
          };
        }
        const lines = members
          .map(
            (m) =>
              `  ${m.name}${m.party ? ` (${m.party})` : ''}${m.riding ? ` — ${m.riding}${m.province ? `, ${m.province}` : ''}` : ''}`,
          )
          .join('\n');
        return {
          text: `${members.length} MP(s) matching "${name}":\n${lines}`,
          structured: { query: name, count: members.length, members },
        };
      },
    },
    {
      name: 'mp_speeches',
      title: 'Parliament: MP statements',
      description:
        'Recent House of Commons / committee statements made BY a Member of ' +
        'Parliament (Hansard). Pass an MP name (e.g. "Chrystia Freeland") or slug. ' +
        'Returns each statement with date, a plain-text excerpt, and a link. Note: ' +
        'this is per-MP — OpenParliament has no public topic search of Hansard.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        mp: z
          .string()
          .min(1)
          .describe('MP name or slug, e.g. "Chrystia Freeland" or "chrystia-freeland".'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max statements (1–25).'),
      }),
      output: z.object({
        mp: z.string(),
        slug: z.string().nullable(),
        count: z.number(),
        statements: z.array(
          z.object({
            date: z.string().nullable(),
            speaker: z.string().nullable(),
            excerpt: z.string().nullable(),
            url: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { mp, limit } = args;
        ctx.log('mp_speeches', { mp, limit });
        const resolved = await resolveSlug(mp, ctx);
        if (!resolved) {
          throw new ToolError(`No current MP matching "${mp}" (try find_mp first).`, {
            retryable: false,
          });
        }
        const params = new URLSearchParams({
          format: 'json',
          politician: resolved.slug,
          limit: String(limit),
        });
        const body = await getJson(`${BASE_URL}/speeches/?${params}`, ctx);
        const statements = objects(body).map((o) => ({
          date: typeof o.time === 'string' ? o.time.slice(0, 10) : null,
          speaker: loc(o.attribution),
          excerpt: stripHtml(o.content)?.slice(0, 240) ?? null,
          url: fullUrl(o.url),
        }));
        if (statements.length === 0) {
          return {
            text: `No statements found for ${resolved.name}.`,
            structured: { mp: resolved.name, slug: resolved.slug, count: 0, statements: [] },
          };
        }
        const lines = statements.map((s) => `  ${s.date ?? '?'}: ${s.excerpt ?? ''}`).join('\n');
        return {
          text: `${statements.length} recent statement(s) by ${resolved.name}:\n${lines}`,
          structured: {
            mp: resolved.name,
            slug: resolved.slug,
            count: statements.length,
            statements,
          },
        };
      },
    },
    {
      name: 'search_bills',
      title: 'Parliament: Search bills',
      description:
        'Find Canadian bills, optionally scoped to a parliamentary session (e.g. ' +
        '"45-1"). Matches the query against bill number and title; returns number, ' +
        'title, session, introduced date, and link.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      input: z.object({
        query: z
          .string()
          .optional()
          .describe('Text to match in number/title, e.g. "carbon" or "C-11".'),
        session: z.string().optional().describe('Session, e.g. "45-1". Omit for the latest.'),
        limit: z.number().int().min(1).max(25).default(10).describe('Max bills (1–25).'),
      }),
      output: z.object({
        count: z.number(),
        bills: z.array(
          z.object({
            number: z.string().nullable(),
            name: z.string().nullable(),
            session: z.string().nullable(),
            introduced: z.string().nullable(),
            url: z.string().nullable(),
          }),
        ),
      }),
      async handler(args, ctx) {
        const { query, session, limit } = args;
        ctx.log('search_bills', { query, session, limit });
        const params = new URLSearchParams({ format: 'json', limit: '400' });
        if (session) params.set('session', session);
        const body = await getJson(`${BASE_URL}/bills/?${params}`, ctx);
        const q = query?.toLowerCase();
        const bills = objects(body)
          .filter((o) => {
            if (!q) return true;
            const num = typeof o.number === 'string' ? o.number.toLowerCase() : '';
            const title = (loc(o.name) ?? '').toLowerCase();
            return num.includes(q) || title.includes(q);
          })
          .slice(0, limit)
          .map((o) => ({
            number: typeof o.number === 'string' ? o.number : null,
            name: loc(o.name),
            session: typeof o.session === 'string' ? o.session : null,
            introduced: typeof o.introduced === 'string' ? o.introduced : null,
            url: fullUrl(o.url),
          }));
        if (bills.length === 0) {
          return { text: 'No bills matched.', structured: { count: 0, bills: [] } };
        }
        const lines = bills
          .map((b) => `  ${b.number ?? '?'} (${b.session ?? '?'}): ${b.name ?? '?'}`)
          .join('\n');
        return {
          text: `${bills.length} bill(s):\n${lines}`,
          structured: { count: bills.length, bills },
        };
      },
    },
  ],
});
