#!/usr/bin/env bun

/**
 * Live source tester — calls sync(ctx) on each implemented source adapter
 * against the real upstream and reports which ones return real data vs fail.
 *
 * Sources are discovered automatically from registry.json (every entry with
 * status "implemented" and has_code), so new sources are covered without
 * editing this file. Browser sources are skipped (they need cookies); a few
 * sources that require user-supplied config get sensible test defaults from
 * the OVERRIDES table below.
 *
 * Usage:
 *   bun scripts/test-sources.mjs             # test all implemented sources
 *   bun scripts/test-sources.mjs --fast      # skip slow sitemap/listing scrapers
 *   bun scripts/test-sources.mjs guardian    # test sources matching a substring
 */

import { readFileSync } from 'node:fs';
import { buildContext } from '../sources/lib/harness.mjs';

const ROOT = new URL('..', import.meta.url);

/**
 * @typedef {import('../sources/lib/types.d.ts').ConfigValue} ConfigValue
 * @typedef {{ config?: Record<string, ConfigValue>, timeout?: number, skip?: string }} Override
 * @typedef {{ id: string, path: string, status?: string, has_code?: boolean,
 *   needsBrowser?: boolean }} RegistryEntry
 * @typedef {{ id: string, path: string, needsBrowser: boolean, scraper: boolean,
 *   config: Record<string, ConfigValue>, timeout: number, skip?: string }} SourceEntry
 * @typedef {{ status: 'PASS' | 'FAIL' | 'TIMEOUT', docs: number, elapsed: string,
 *   error: string | undefined }} TestResult
 * @typedef {{ path: string, status: 'PASS' | 'FAIL' | 'TIMEOUT' | 'SKIP',
 *   docs: number | string, elapsed: string, error: string | undefined }} Row
 */

/**
 * Per-source test overrides, keyed by source id:
 *   - config: test config for sources that require user input
 *   - timeout: override the auto-detected timeout (ms)
 *   - skip: reason string to skip the source entirely
 *
 * @type {Record<string, Override>}
 */
const OVERRIDES = {
  // Config-required sources — supply representative test inputs.
  'rss-feeds': { config: { feeds: ['https://hnrss.org/frontpage'] } },
  'financial-times-headlines': { config: { sections: ['home'] } },
  'sec-filings': { config: { tickers: ['AAPL'] }, timeout: 120_000 },
  // Generic sources with no single upstream to test against.
  'sitemap-blog': { skip: 'generic source — needs user-provided sitemaps' },
};

const DEFAULT_TIMEOUT = 30_000;
const SCRAPER_TIMEOUT = 90_000;

/**
 * Load implemented sources from the registry, enriching each with whether it
 * is a (slow) scraper and any per-source overrides.
 *
 * @returns {SourceEntry[]} Every implemented source with code, path-sorted.
 */
function discoverSources() {
  /** @type {{ sources: RegistryEntry[] }} */
  const registry = JSON.parse(readFileSync(new URL('registry.json', ROOT), 'utf8'));
  return registry.sources
    .filter((entry) => entry.status === 'implemented' && entry.has_code)
    .map((entry) => {
      const override = OVERRIDES[entry.id] ?? {};
      const scraper = isScraper(entry.path);
      return {
        id: entry.id,
        path: entry.path,
        needsBrowser: Boolean(entry.needsBrowser),
        scraper,
        config: override.config || {},
        timeout: override.timeout || (scraper ? SCRAPER_TIMEOUT : DEFAULT_TIMEOUT),
        skip: override.skip,
      };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Heuristically classify a source as a slow scraper by checking whether its
 * module uses the sitemap/listing scraping helpers.
 *
 * @param {string} path - The source's directory, relative to the repo root.
 * @returns {boolean} True when it scrapes.
 */
function isScraper(path) {
  try {
    const source = readFileSync(new URL(`${path}/index.mjs`, ROOT), 'utf8');
    return source.includes('scrapeSitemapBlog') || source.includes('scrapeListingBlog');
  } catch {
    return false;
  }
}

/**
 * The context one test run gets.
 *
 * Built by the harness rather than by hand. The hand-rolled version this
 * replaced carried no `deadline` at all — so `hasDeadlinePassed()` compared
 * against `undefined`, was never true, and every deadline-bounded source was
 * tested with the one branch that bounds its work permanently switched off.
 * `buildContext` derives a soft deadline from the same timeout this script
 * already enforces hard, which is the pairing the sources are written against.
 *
 * @param {SourceEntry} entry - The source about to be run.
 * @returns {import('../sources/lib/types.d.ts').SyncContext} Its context.
 */
function makeContext(entry) {
  return buildContext({
    config: entry.config,
    timeoutMs: entry.timeout,
    onLog: (level, message) => {
      if (level === 'info') console.log('  ', message);
      else console.warn(`  [${level.toUpperCase()}]`, message);
    },
  });
}

/**
 * Everything wrong with what a source returned, as printable strings.
 *
 * @param {unknown} result - Whatever `sync()` resolved to.
 * @returns {string[]} The issues; empty when the result is usable.
 */
function validateResult(result) {
  if (!result || typeof result !== 'object') {
    return ['sync() did not return an object'];
  }
  /** @type {string[]} */
  const issues = [];
  const { documents, stats } = /** @type {{ documents?: unknown, stats?: unknown }} */ (result);
  if (!Array.isArray(documents)) {
    issues.push('missing documents array');
  }
  const fetched = /** @type {{ fetched?: unknown } | undefined} */ (stats)?.fetched;
  if (typeof fetched !== 'number') {
    issues.push('missing stats.fetched');
  }
  if (Array.isArray(documents) && documents.length > 0) {
    const document = /** @type {Record<string, unknown>} */ (documents[0]);
    for (const field of ['id', 'title', 'text', 'url']) {
      const value = document[field];
      if (!value) issues.push(`first document missing "${field}"`);
    }
  }
  if (Array.isArray(documents) && documents.length === 0) {
    issues.push('returned 0 documents');
  }
  return issues;
}

/**
 * Reject `promise` if it has not settled within `ms`.
 *
 * @template T
 * @param {Promise<T>} promise - What to race.
 * @param {number} ms - The budget.
 * @returns {Promise<T>} The value, or a timeout error.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Run one source against its live upstream and judge what came back.
 *
 * @param {SourceEntry} entry - The source to run.
 * @param {() => number} now - A monotonic clock, for the elapsed time.
 * @returns {Promise<TestResult>} What happened.
 */
async function testSource(entry, now) {
  const start = now();
  try {
    /** @type {{ sync: (context: import('../sources/lib/types.d.ts').SyncContext) => Promise<unknown> }} */
    const module = await import(new URL(`${entry.path}/index.mjs`, ROOT).href);
    const context = makeContext(entry);
    const result = await withTimeout(module.sync(context), entry.timeout);
    const elapsed = ((now() - start) / 1000).toFixed(1);
    const issues = validateResult(result);
    const documents = /** @type {{ documents?: unknown[] } | undefined} */ (result)?.documents;
    const documentCount = Array.isArray(documents) ? documents.length : 0;
    if (issues.length > 0) {
      return { status: 'FAIL', docs: documentCount, elapsed, error: issues.join('; ') };
    }
    return { status: 'PASS', docs: documentCount, elapsed, error: undefined };
  } catch (error) {
    const elapsed = ((now() - start) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: message.includes('Timed out') ? 'TIMEOUT' : 'FAIL',
      docs: 0,
      elapsed,
      error: message.slice(0, 120),
    };
  }
}

// --- Main ---

const now = () => performance.now();
const cliArguments = process.argv.slice(2);
const fastMode = cliArguments.includes('--fast');
const filterPath = cliArguments.find((argument) => !argument.startsWith('--'));

let toTest = discoverSources();
if (filterPath) {
  toTest = toTest.filter((source) => source.path.includes(filterPath));
  if (toTest.length === 0) {
    console.error(`No source matching "${filterPath}"`);
    process.exit(1);
  }
}

console.log(
  `\nTesting ${toTest.length} sources${fastMode ? ' (fast mode — skipping scrapers)' : ''}...\n`,
);

/** @type {Row[]} */
const results = [];

for (const entry of toTest) {
  const skipReason = resolveSkip(entry, fastMode);
  if (skipReason) {
    console.log(`SKIP  ${entry.path}  (${skipReason})`);
    results.push({
      path: entry.path,
      status: 'SKIP',
      docs: '-',
      elapsed: '-',
      error: skipReason,
    });
    continue;
  }

  process.stdout.write(`TEST  ${entry.path}...`);
  const result = await testSource(entry, now);
  results.push({ path: entry.path, ...result });

  console.log(
    ` ${result.status}  ${result.docs} docs  ${result.elapsed}s${
      result.error ? `  — ${result.error}` : ''
    }`,
  );
}

printSummary(results);

const failed = results.filter((r) => r.status === 'FAIL').length;
const timedOut = results.filter((r) => r.status === 'TIMEOUT').length;
if (failed > 0 || timedOut > 0) {
  process.exit(1);
}

/**
 * Decide whether a source should be skipped this run, and why.
 *
 * @param {SourceEntry} entry - The source in question.
 * @param {boolean} fast - Whether `--fast` was passed.
 * @returns {string} The reason, or `''` to run it.
 */
function resolveSkip(entry, fast) {
  if (entry.skip) return entry.skip;
  if (entry.needsBrowser) return 'needs browser + cookies';
  if (fast && entry.scraper) return 'scraper — skipped in fast mode';
  return '';
}

/**
 * Print the results table and the tallies under it.
 *
 * @param {Row[]} rows - Every source's outcome, in run order.
 * @returns {void} Nothing; it prints.
 */
function printSummary(rows) {
  console.log(`\n${'='.repeat(90)}`);
  console.log('SUMMARY');
  console.log('='.repeat(90));
  console.log(
    `${'Status'.padEnd(8)}${'Source'.padEnd(35)}${'Docs'.padEnd(8)}${'Time'.padEnd(8)}Error`,
  );
  console.log('-'.repeat(90));

  for (const row of rows) {
    console.log(
      row.status.padEnd(8) +
        row.path.padEnd(35) +
        String(row.docs).padEnd(8) +
        `${row.elapsed}s`.padEnd(8) +
        (row.error || ''),
    );
  }

  /** @type {(status: Row['status']) => number} */
  const count = (status) => rows.filter((r) => r.status === status).length;
  console.log('-'.repeat(90));
  console.log(
    `PASS: ${count('PASS')}  FAIL: ${count('FAIL')}  TIMEOUT: ${count('TIMEOUT')}  ` +
      `SKIP: ${count('SKIP')}  TOTAL: ${rows.length}`,
  );
  console.log();
}
