/**
 * The arXiv directory — the subject taxonomy, fetched live (trove docs/39).
 *
 * arXiv's `search_query` syntax is precise and unguessable: papers on machine
 * learning live under `cat:cs.LG`, and knowing that is a memory test rather
 * than a research skill. This turns the field into a browse of arXiv's own
 * subject list.
 *
 * **Nothing here is hard-coded.** The taxonomy is arXiv's to change — new
 * categories appear (`cs.AI` was joined by `cs.LG`, `econ` arrived in 2017) —
 * so a list baked into this file would be wrong the first time they moved and
 * silently wrong forever after. It is read from the OAI-PMH `ListSets` verb,
 * which is the archive describing itself.
 *
 * @module
 */

/** OAI-PMH endpoint. Redirects to oaipmh.arxiv.org; the seam's fetch follows it. */
const SETS_URL = 'https://export.arxiv.org/oai2?verb=ListSets';

/** `<set>` blocks, tolerant of the whitespace OAI responses carry. */
const SET_PATTERN = /<set>\s*<setSpec>(.*?)<\/setSpec>\s*<setName>(.*?)<\/setName>/gs;

/**
 * Turn an OAI `setSpec` into an arXiv category, or nothing.
 *
 * The archive nests its sets: `cs:cs:AI` is the AI category of the CS archive,
 * `physics:astro-ph:CO` the cosmology category of astrophysics. The category
 * arXiv's search syntax wants is always the last two segments joined by a dot
 * — `cs.AI`, `astro-ph.CO`.
 *
 * Two-segment sets are the legacy archives that never gained sub-categories
 * (`physics:hep-th`), and those ARE categories in their own right. A bare
 * archive (`cs`) is not — `cat:cs` matches nothing — so it is skipped rather
 * than offered as a query that would quietly return no papers.
 *
 * @param {string} spec - The OAI setSpec.
 * @returns {string | undefined} An arXiv category.
 */
export function specToCategory(spec) {
  const parts = spec.split(':').filter(Boolean);
  if (parts.length >= 3) return `${parts.at(-2)}.${parts.at(-1)}`;
  if (parts.length === 2 && parts[0] !== parts[1]) return parts[1];
}

/**
 * Every category arXiv currently publishes, in the order the archive lists them.
 *
 * @param {string} xml - An OAI `ListSets` response.
 * @returns {Array<{category: string, name: string}>} Every category, deduplicated.
 */
export function parseCategories(xml) {
  /** @type {Array<{category: string, name: string}>} */
  const out = [];
  const seen = new Set();
  // Both groups are required by the pattern, so a match always carries them;
  // the defaults are what lets the destructuring say so.
  for (const [, spec = '', name = ''] of xml.matchAll(SET_PATTERN)) {
    const category = specToCategory(spec.trim());
    if (!category || seen.has(category)) continue;
    seen.add(category);
    out.push({ category, name: name.trim() });
  }
  return out;
}

/**
 * Answer a directory query over the taxonomy.
 *
 * An empty query returns the taxonomy itself — unlike a podcast index, this IS
 * a list, and a short enough one to browse. Matching is on both the code and
 * the subject name, because people arrive knowing one or the other.
 *
 * @param {import('../types.d.ts').DirectoryQuery} input
 * @param {import('../types.d.ts').DirectoryContext} context - The directory context (guarded fetch + log).
 * @returns {Promise<import('../types.d.ts').DirectoryEntry[]>} Category entries.
 */
export async function query(input, context) {
  const response = await context.fetch(SETS_URL);
  if (!response.ok) {
    throw new Error(`arXiv returned ${String(response.status)} for its subject list`);
  }
  const categories = parseCategories(await response.text());

  const term = (input.query ?? '').trim().toLowerCase();
  const matched = term
    ? categories.filter(
        (c) => c.category.toLowerCase().includes(term) || c.name.toLowerCase().includes(term),
      )
    : categories;

  return matched.slice(0, input.limit).map((c) => ({
    // The value is a whole arXiv query, because that is what the field holds —
    // the user can still refine it by hand afterwards.
    value: `cat:${c.category}`,
    title: c.name,
    subtitle: c.category,
  }));
}
