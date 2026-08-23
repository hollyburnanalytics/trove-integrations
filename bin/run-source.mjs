#!/usr/bin/env bun
/**
 * Headless source runner — exercise a source adapter standalone.
 *
 * Runs a source through the same `context` contract as the production
 * runtime (via lib/harness.ts), streaming its logs and progress to the
 * terminal and printing the resulting documents/cursor/stats. This is the loop
 * for reproducing and debugging source failures locally.
 *
 * Usage:
 *   bun run source <source-dir> [options]
 *   (source-dir is relative to the repo root, e.g. sources/hacker-news)
 *
 * Options:
 *   --method <sync|query>   Method to invoke (default: sync)
 *   --timeout <ms>          Hard-timeout budget (default: 120000)
 *   --cursor <json>         Resume cursor, as a JSON value
 *   --config <key=value>    Source config entry (repeatable)
 *   --json                  Print the full result as JSON instead of a summary
 *
 * Examples:
 *   bun run source sources/arxiv-papers --timeout 120000
 *   bun run source sources/hacker-news --json
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runSource } from '../sources/lib/harness.ts';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * What the runner was asked to do.
 *
 * The source path is optional while the arguments are being read and required
 * once they have been: {@link parseArguments} refuses a run without one, and
 * says so in its return type rather than leaving every reader to re-check.
 *
 * @typedef {{ method: string, timeoutMs: number, cursor: unknown,
 *   config: Record<string, string>, json: boolean,
 *   sourcePath: string | undefined }} Options
 * @typedef {Options & { sourcePath: string }} ParsedOptions
 */

/**
 * Apply one command-line argument to `options`.
 *
 * Returns how many arguments it consumed, because the value-taking options
 * consume the one after them — which is the whole reason the caller walks an
 * index rather than iterating the array.
 *
 * @param {Options} options - The options being built, mutated in place.
 * @param {string} argument - The argument to apply.
 * @param {string} next - The argument after it, for the options that take a value.
 * @returns {number} How many arguments were consumed: 1, or 2 with a value.
 */
function applyArgument(options, argument, next) {
  switch (argument) {
    case '--method': {
      options.method = next;
      return 2;
    }
    case '--timeout': {
      options.timeoutMs = Number(next);
      return 2;
    }
    case '--cursor': {
      options.cursor = JSON.parse(next || 'null');
      return 2;
    }
    case '--config': {
      const [key = '', ...rest] = next.split('=');
      options.config[key] = rest.join('=');
      return 2;
    }
    case '--json': {
      options.json = true;
      return 1;
    }
    default: {
      if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
      options.sourcePath = argument;
      return 1;
    }
  }
}

/**
 * Parse argv into the runner options.
 *
 * @param {string[]} argv - The raw process arguments.
 * @returns {ParsedOptions} The parsed options, source path included.
 */
function parseArguments(argv) {
  /** @type {Options} */
  const options = {
    method: 'sync',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cursor: undefined,
    config: {},
    json: false,
    sourcePath: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    index += applyArgument(options, argv[index] ?? '', argv[index + 1] ?? '') - 1;
  }
  const { sourcePath } = options;
  if (!sourcePath) throw new Error('Usage: run-source <source-dir> [options]');
  if (!['sync', 'query'].includes(options.method)) {
    throw new Error(`--method must be sync or query, got ${options.method}`);
  }
  return { ...options, sourcePath };
}

/** Read a source's manifest.json, or {} if absent. */
/**
 * @param {string} sourcePath - The source directory.
 * @returns {Record<string, any>} Its manifest.
 */
function readManifest(sourcePath) {
  const abs = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(process.cwd(), sourcePath);
  const manifestPath = path.join(abs, 'manifest.json');
  return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
}

const COLOR = {
  info: '\u{1B}[36m',
  warn: '\u{1B}[33m',
  error: '\u{1B}[31m',
  dim: '\u{1B}[2m',
  reset: '\u{1B}[0m',
};

/**
 * Timestamped log line written to stderr (stdout stays clean for --json).
 *
 * @param {string} level - One of info, warn, error.
 * @param {string} message - What to print.
 */
function logLine(level, message) {
  const ts = new Date().toISOString().slice(11, 23);
  const color = /** @type {Record<string, string>} */ (COLOR)[level] ?? '';
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
    logLine('error', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  logLine('error', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
