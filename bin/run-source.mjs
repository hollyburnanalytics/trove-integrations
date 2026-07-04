#!/usr/bin/env bun
/**
 * Headless source runner — exercise a source adapter standalone.
 *
 * Runs a source through the same `context` contract as the production
 * runtime (via lib/harness.mjs), streaming its logs and progress to the
 * terminal and printing the resulting documents/cursor/stats. This is the loop
 * for reproducing and debugging source failures locally.
 *
 * Usage:
 *   bun run source <source-dir> [options]
 *   (source-dir is relative to the repo root, e.g. sources/070-news/hacker-news)
 *
 * Options:
 *   --method <sync|query>   Method to invoke (default: sync)
 *   --timeout <ms>          Hard-timeout budget (default: 120000)
 *   --cursor <json>         Resume cursor, as a JSON value
 *   --config <key=value>    Source config entry (repeatable)
 *   --json                  Print the full result as JSON instead of a summary
 *
 * Examples:
 *   bun run source sources/500-science/arxiv-papers --timeout 120000
 *   bun run source sources/070-news/hacker-news --json
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runSource } from '../sources/lib/harness.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Parse argv into the runner options. */
function parseArguments(argv) {
  const options = {
    method: 'sync',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cursor: undefined,
    config: {},
    json: false,
    sourcePath: undefined,
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
      case '--json': {
        options.json = true;
        break;
      }
      default: {
        if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
        options.sourcePath = argument;
      }
    }
  }
  if (!options.sourcePath) throw new Error('Usage: run-source <source-dir> [options]');
  if (!['sync', 'query'].includes(options.method)) {
    throw new Error(`--method must be sync or query, got ${options.method}`);
  }
  return options;
}

/** Read a source's manifest.json, or {} if absent. */
function readManifest(sourcePath) {
  const abs = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(process.cwd(), sourcePath);
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.sourcePath);

  logLine(
    'info',
    `running ${manifest.id ?? options.sourcePath}.${options.method}() (timeout ${options.timeoutMs}ms)`,
  );
  const startedAt = Date.now();

  try {
    const result = await runSource({
      sourcePath: options.sourcePath,
      method: /** @type {'sync' | 'query'} */ (options.method),
      config: options.config,
      cursor: options.cursor,
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
  }
}

try {
  await main();
} catch (error) {
  logLine('error', error?.message ?? String(error));
  process.exitCode = 1;
}
