#!/usr/bin/env bun
/**
 * Publish-date coverage audit.
 *
 * Runs every runnable source against its live upstream and reports how many of
 * the documents it returns carry a publication date. A source that cannot get a
 * date leaves `date` unset (the server still records its own ingestion date),
 * so "undated" here is a real measurement, not an artifact of a fallback.
 *
 * Sources needing user input are run with a representative probe config; the
 * only SKIPs are sources that genuinely cannot run unattended here — on-disk
 * data, a browser login, or credentials.
 *
 * Usage:
 *   bun run audit:dates              # all runnable sources
 *   bun run audit:dates --json       # machine-readable
 *   bun run audit:dates <substring>  # only sources whose id matches
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSource } from '../sources/lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES_DIR = path.join(ROOT, 'sources');
const TIMEOUT_MS = 120_000;

/**
 * Representative config for sources that do nothing without user input. These
 * are audit probes, not defaults — just enough of a feed/ticker/book list to
 * exercise the source's real date path against live data.
 */
const PROBE_CONFIG = {
  'rss-feeds': { feeds: ['https://daringfireball.net/feeds/main', 'https://avc.com/feed'] },
  'sec-filings': { tickers: ['AAPL'] },
  openstax: { books: ['college-physics-2e'] },
};

/** Sources that need input the audit cannot supply, with the reason to print. */
const NEEDS_INPUT = {
  'x-bookmarks': 'needs X credentials + browser login',
};

/** Discover `{ id, category, directory, manifest }` for every source in the catalog. */
function discoverSources() {
  const found = [];
  for (const category of readdirSync(SOURCES_DIR, { withFileTypes: true })) {
    if (!category.isDirectory() || category.name === 'lib') continue;
    const categoryDirectory = path.join(SOURCES_DIR, category.name);
    for (const entry of readdirSync(categoryDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(categoryDirectory, entry.name);
      const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      found.push({ id: manifest.id, category: category.name, directory, manifest });
    }
  }
  return found.toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * Why this source cannot be audited live, or undefined if it can. Note that
 * `location: client` is *not* a reason — that is the source's default executor,
 * not a constraint on running it here; only on-disk data, a browser login, or
 * required user config actually blocks an unattended run.
 */
function skipReason({ id, manifest }) {
  if (manifest.transport === 'local') return 'reads on-disk data (local transport)';
  if (manifest.needs_browser) return 'needs a browser session';
  return NEEDS_INPUT[id];
}

/** Run one source and summarize its date coverage. */
async function auditSource(source) {
  const skip = skipReason(source);
  if (skip) return { ...source, status: 'skip', reason: skip };

  try {
    const result = await runSource({
      sourcePath: source.directory,
      config: PROBE_CONFIG[source.id],
      timeoutMs: TIMEOUT_MS,
    });
    const dated = result.documents.filter((document) => document.date);
    return {
      ...source,
      status: 'ok',
      fetched: result.documents.length,
      dated: dated.length,
      undated: result.documents.length - dated.length,
      sample: dated[0]?.date,
    };
  } catch (error) {
    return { ...source, status: 'error', reason: error.message };
  }
}

/** Format one audited source as a table row. */
function formatRow({ id, status, fetched, dated, undated, sample, reason }) {
  const name = id.padEnd(24);
  if (status === 'skip') return `${name} SKIP   ${reason}`;
  if (status === 'error') return `${name} ERROR  ${reason}`;
  if (fetched === 0) return `${name} EMPTY  no new documents this run`;
  const pct = Math.round((dated / fetched) * 100);
  const flag = undated === 0 ? ' ' : '!';
  return `${name}${flag}${String(pct).padStart(4)}%  ${dated}/${fetched} dated   ${sample ?? ''}`;
}

const arguments_ = process.argv.slice(2);
const asJson = arguments_.includes('--json');
const filter = arguments_.find((argument) => !argument.startsWith('--'));

const sources = discoverSources().filter((source) => !filter || source.id.includes(filter));
const results = [];
for (const source of sources) {
  const result = await auditSource(source);
  results.push(result);
  if (!asJson) console.log(formatRow(result));
}

if (asJson) {
  console.log(JSON.stringify(results, undefined, 2));
} else {
  const ran = results.filter((r) => r.status === 'ok' && r.fetched > 0);
  const totalDocuments = ran.reduce((sum, r) => sum + r.fetched, 0);
  const totalDated = ran.reduce((sum, r) => sum + r.dated, 0);
  const gaps = ran.filter((r) => r.undated > 0);
  console.log(
    `\n${ran.length} sources audited · ${totalDated}/${totalDocuments} documents dated` +
      (gaps.length > 0 ? ` · gaps: ${gaps.map((r) => r.id).join(', ')}` : ' · no gaps'),
  );
}
