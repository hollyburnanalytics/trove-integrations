import { defineMcpServer } from '@ontrove/mcp';
import { getWcatDecision } from './tools/get-wcat-decision.ts';
import { searchReviewDecisions } from './tools/search-review-decisions.ts';
import { searchWcatDecisions } from './tools/search-wcat-decisions.ts';

/**
 * BC Workers' Comp Decisions — a no-auth hosted MCP server over the two public
 * BC workers'-compensation appeal-decision search sites. Neither has a documented
 * API, so each tool drives the site's own server-rendered search live and parses
 * the results (robots.txt permits both search surfaces):
 *
 *  - `search_wcat_decisions` / `get_wcat_decision` — the Workers' Compensation
 *    Appeal Tribunal's "Search past decisions" page (www.wcat.bc.ca), with its full
 *    facet surface (classification, application/document type, date range) and a
 *    stable link to each decision's official PDF.
 *  - `search_review_decisions` — the WorkSafeBC Review Division search app
 *    (rdpubsearch.online.worksafebc.com), 2013–present, keyword-driven.
 *
 * All three tools are read-only. They return each tribunal's own public search
 * summaries and link to the official record — no full decision text is stored or
 * reproduced.
 */
export default defineMcpServer({
  tools: [searchWcatDecisions, getWcatDecision, searchReviewDecisions],
});
