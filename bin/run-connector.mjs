#!/usr/bin/env bun
/**
 * Headless connector runner — exercise a connector standalone.
 *
 * Runs a connector through the same `context` contract as the production
 * runtime (via lib/harness.mjs), streaming its logs and progress to the
 * terminal and printing the resulting documents/cursor/stats. This is the loop
 * for reproducing and debugging connector failures locally.
 *
 * Usage:
 *   bun run connector <connector-dir> [options]
 *   (connector-dir is relative to the repo root, e.g. sources/070-news/hacker-news)
 *
 * Options:
 *   --method <sync|query>   Method to invoke (default: sync)
 *   --timeout <ms>          Hard-timeout budget (default: 120000)
 *   --cursor <json>         Resume cursor, as a JSON value
 *   --config <key=value>    Connector config entry (repeatable)
 *   --no-browser            Skip launching a browser even if the manifest needs one
 *   --headless              Launch the browser headless (or set TROVE_HEADLESS=1)
 *   --json                  Print the full result as JSON instead of a summary
 *
 * Examples:
 *   bun run connector sources/500-science/arxiv-papers --timeout 120000
 *   bun run connector sources/070-news/hacker-news --json
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runConnector } from '../sources/lib/harness.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Parse argv into the runner options. */
function parseArguments(argv) {
  const options = {
    method: 'sync',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cursor: undefined,
    config: {},
    browser: true,
    headless: process.env.TROVE_HEADLESS === '1',
    json: false,
    connectorPath: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    switch (argument) {
      case '--method': {
        options.method = argv[++index];
        break;
      }
      case '--timeout': {
        options.timeoutMs = Number(argv[++index]);
        break;
      }
      case '--cursor': {
        options.cursor = JSON.parse(argv[++index]);
        break;
      }
      case '--config': {
        const [key, ...rest] = argv[++index].split('=');
        options.config[key] = rest.join('=');
        break;
      }
      case '--no-browser': {
        options.browser = false;
        break;
      }
      case '--headless': {
        options.headless = true;
        break;
      }
      case '--json': {
        options.json = true;
        break;
      }
      default: {
        if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
        options.connectorPath = argument;
      }
    }
  }
  if (!options.connectorPath) throw new Error('Usage: run-connector <connector-dir> [options]');
  if (!['sync', 'query'].includes(options.method)) {
    throw new Error(`--method must be sync or query, got ${options.method}`);
  }
  return options;
}

/** Read a connector's manifest.json, or {} if absent. */
function readManifest(connectorPath) {
  const abs = path.isAbsolute(connectorPath)
    ? connectorPath
    : path.resolve(process.cwd(), connectorPath);
  const manifestPath = path.join(abs, 'manifest.json');
  return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
}

const COLOR = {
  info: '\u001B[36m',
  warn: '\u001B[33m',
  error: '\u001B[31m',
  dim: '\u001B[2m',
  reset: '\u001B[0m',
};

/** Timestamped log line written to stderr (stdout stays clean for --json). */
function logLine(level, message) {
  const ts = new Date().toISOString().slice(11, 23);
  const color = COLOR[level] ?? '';
  process.stderr.write(
    `${COLOR.dim}${ts}${COLOR.reset} ${color}${level.toUpperCase()}${COLOR.reset} ${message}\n`,
  );
}

/** Launch a Playwright browser context for connectors that need one. */
async function launchBrowser(connectorPath, headless) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless,
    args: ['--disable-dev-shm-usage'], // shared-memory flag for CI/containers, not evasion
    ...(headless ? {} : { channel: 'chrome' }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  logLine('info', `launched browser (${headless ? 'headless' : 'chrome'}) for ${connectorPath}`);
  return { browser, context };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.connectorPath);

  let browser;
  let browserContext;
  if (manifest.needs_browser && options.browser) {
    ({ browser, context: browserContext } = await launchBrowser(
      options.connectorPath,
      options.headless,
    ));
  } else if (manifest.needs_browser) {
    logLine('warn', 'manifest needs a browser but --no-browser was passed; running without one');
  }

  logLine(
    'info',
    `running ${manifest.id ?? options.connectorPath}.${options.method}() (timeout ${options.timeoutMs}ms)`,
  );
  const startedAt = Date.now();

  try {
    const result = await runConnector({
      connectorPath: options.connectorPath,
      method: /** @type {'sync' | 'query'} */ (options.method),
      config: options.config,
      cursor: options.cursor,
      browser: browserContext,
      timeoutMs: options.timeoutMs,
      onLog: logLine,
      onProgress: (documentsSoFar, message) =>
        logLine('info', `progress: ${documentsSoFar} docs — ${message}`),
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
    } else {
      logLine('info', `done in ${elapsed}s — ${result.documents.length} documents`);
      for (const document of result.documents.slice(0, 10)) {
        process.stdout.write(`  • ${document.id}  ${COLOR.dim}${document.title}${COLOR.reset}\n`);
      }
      if (result.documents.length > 10) {
        process.stdout.write(
          `  ${COLOR.dim}… and ${result.documents.length - 10} more${COLOR.reset}\n`,
        );
      }
      process.stdout.write(
        `${COLOR.dim}cursor: ${JSON.stringify(result.cursor)}\nstats:  ${JSON.stringify(result.stats)}${COLOR.reset}\n`,
      );
    }
  } catch (error) {
    logLine('error', error?.message ?? String(error));
    process.exitCode = 1;
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  logLine('error', error?.message ?? String(error));
  process.exitCode = 1;
}
