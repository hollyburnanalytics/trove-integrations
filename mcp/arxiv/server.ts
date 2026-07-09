import { defineMcpServer } from '@ontrove/mcp';
import { getPaper } from './tools/get-paper.ts';
import { getPaperContent } from './tools/get-paper-content.ts';
import { savePaper } from './tools/save-paper.ts';
import { searchPapers } from './tools/search-papers.ts';

/**
 * arXiv — a no-auth hosted MCP server over the public arXiv API.
 *
 * The search/metadata API returns Atom XML (not JSON) and the runtime has no
 * DOMParser, so both the Atom feed and the LaTeXML full-text HTML are parsed
 * with string/regex extraction below.
 *
 * Egress is resilient: an in-isolate cache collapses repeat queries, requests
 * are throttled to arXiv's requested rate, and failures retry with backoff and
 * surface a distinct, actionable error for rate-limits vs. genuine outages.
 *
 * Four read-only surfaces, each in its own module under `tools/`:
 *  - `search_papers` — search arXiv by free-text or scoped fields;
 *  - `get_paper` — one paper's metadata by id;
 *  - `get_paper_content` — a paper's full text as labelled sections + refs;
 *  - `save_paper` — ingest a paper into the Trove knowledge base.
 */
export default defineMcpServer({
  scopes: ['trove:ingest'],
  tools: [searchPapers, getPaper, getPaperContent, savePaper],
});
