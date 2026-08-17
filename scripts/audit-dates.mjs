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
/** @type {Record<string, Record<string, import('../sources/lib/types.d.ts').ConfigValue>>} */
const PROBE_CONFIG = {
  'rss-feeds': { feeds: ['https://daringfireball.net/feeds/main', 'https://avc.com/feed'] },
  'sec-filings': { tickers: ['AAPL'] },
  openstax: { books: ['college-physics-2e'] },
};

/** Sources that need input the audit cannot supply, with the reason to print. */
/** @type {Record<string, string>} */
const NEEDS_INPUT = {
  'x-bookmarks': 'needs X credentials + browser login',
};

/**
 * One source as this script sees it, and one row of its output.
 *
 * A row is one of two things and never a blend: a source that did not run, or
 * one that did and has counts. Splitting the union is what lets the formatter
 * and the summary read `fetched` without asking whether it is there.
 *
 * @typedef {{ id: string, directory: string, manifest: Record<string, unknown> }} Source
 * @typedef {Source & { status: 'skip', reason: string }} SkippedRow
 * @typedef {Source & { status: 'error', reason: string }} FailedRow
 * @typedef {Source & { status: 'ok', fetched: number, dated: number, undated: number,
 *   sample?: string }} CountedRow
 * @typedef {SkippedRow | FailedRow | CountedRow} AuditRow
 */

/**
 * Discover `{ id, directory, manifest }` for every source in the catalog.
 *
 * @returns {Source[]} Every source in the catalog, id-sorted.
 */
function discoverSources() {
  /** @type {Source[]} */
  const found = [];
  const entries = readdirSync(SOURCES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'lib') continue;
    const directory = path.join(SOURCES_DIR, entry.name);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    found.push({ id: String(manifest.id), directory, manifest });
  }
  return found.toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * Why this source cannot be audited live, or undefined if it can. Note that
 * `location: client` is *not* a reason — that is the source's default executor,
 * not a constraint on running it here; only on-disk data, a browser login, or
 * required user config actually blocks an unattended run.
 * @param {Source} source - The source to judge.
 * @returns {string | undefined} Why it cannot be audited, or nothing.
 */
function skipReason({ id, manifest }) {
  if (manifest.transport === 'local') return 'reads on-disk data (local transport)';
  if (manifest.needs_browser) return 'needs a browser session';
  return NEEDS_INPUT[id];
}

/**
 * Run one source and summarize its date coverage.
 *
 * @param {Source} source - The source to run.
 * @returns {Promise<AuditRow>} One result row.
 */
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
    return {
      ...source,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Format one audited source as a table row.
 *
 * @param {AuditRow} row - One audit result.
 * @returns {string} The printable row.
 */
function formatRow(row) {
  const name = row.id.padEnd(24);
  if (row.status === 'skip') return `${name} SKIP   ${row.reason}`;
  if (row.status === 'error') return `${name} ERROR  ${row.reason}`;
  if (row.fetched === 0) return `${name} EMPTY  no new documents this run`;
  const pct = Math.round((row.dated / row.fetched) * 100);
  const flag = row.undated === 0 ? ' ' : '!';
  return `${name}${flag}${String(pct).padStart(4)}%  ${row.dated}/${row.fetched} dated   ${
    row.sample ?? ''
  }`;
}

const arguments_ = process.argv.slice(2);
const asJson = arguments_.includes('--json');
const filter = arguments_.find((argument) => !argument.startsWith('--'));

const sources = discoverSources().filter((source) => !filter || source.id.includes(filter));
/** @type {AuditRow[]} */
const results = [];
for (const source of sources) {
  const result = await auditSource(source);
  results.push(result);
  if (!asJson) console.log(formatRow(result));
}

if (asJson) {
  console.log(JSON.stringify(results, undefined, 2));
} else {
  // Collected in a loop rather than filtered: the reductions below read counts
  // that only the `status === 'ok'` arm has, and neither `filter` nor `flatMap`
  // carries that narrowing out of the callback without a type predicate. The
  // loop narrows where it stands, and says what it keeps.
  /** @type {CountedRow[]} */
  const ran = [];
  for (const row of results) {
    if (row.status === 'ok' && row.fetched > 0) ran.push(row);
  }
  const totalDocuments = ran.reduce((sum, r) => sum + r.fetched, 0);
  const totalDated = ran.reduce((sum, r) => sum + r.dated, 0);
  const gaps = ran.filter((r) => r.undated > 0);
  console.log(
    `\n${ran.length} sources audited · ${totalDated}/${totalDocuments} documents dated` +
      (gaps.length > 0 ? ` · gaps: ${gaps.map((r) => r.id).join(', ')}` : ' · no gaps'),
  );
}
