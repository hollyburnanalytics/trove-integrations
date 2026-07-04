/**
 * In-process source-adapter harness.
 *
 * Runs a source's `sync()` / `query()` through the *same* `context` contract
 * the production runtime builds, but with plain in-process callbacks. This lets
 * source adapters be exercised standalone — from the `bin/run-source.mjs` CLI
 * and from contract/fixture tests in CI.
 *
 * CONTRACT:
 *   - soft deadline = Date.now() + floor(timeoutMs * {@link SOFT_BUDGET_RATIO})
 *   - context.log.{info,warn,error}(msg)
 *   - context.progress(documentsSoFar, message)
 *   - the source returns `{ documents: Doc[], cursor?, stats? }`, where each
 *     Doc has string `id`, `title`, and `text`.
 *
 * The harness validates the returned shape so source-adapter bugs surface here
 * — in CI — instead of as an opaque runtime error.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default hard-timeout budget when a caller does not supply one, in ms. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Fraction of the hard-timeout budget granted to the source adapter as its soft
 * deadline. The remaining margin covers the final in-flight fetch and the
 * result/cursor write.
 */
export const SOFT_BUDGET_RATIO = 0.8;

/**
 * Thrown when a source returns a value that violates the result contract
 * (not an object, missing/!array `documents`, or a malformed document). This is
 * the in-harness analogue of the app's "Invalid response from source
 * runtime", raised with a specific reason.
 */
export class InvalidSourceResponseError extends Error {
  /** @param {string} message - Why the response is invalid. */
  constructor(message) {
    super(message);
    this.name = 'InvalidSourceResponseError';
  }
}

/**
 * Build the `context` object passed to a source's `sync()` / `query()`.
 *
 * @param {object} options - Context inputs.
 * @param {Record<string, string>} [options.config] - Source config.
 * @param {Record<string, string>} [options.credentials] - Source credentials.
 * @param {unknown} [options.cursor] - Resume cursor from a prior run.
 * @param {unknown} [options.browser] - Playwright browser context, or null.
 * @param {number} [options.timeoutMs] - Hard-timeout budget in ms.
 * @param {number} [options.now] - Current epoch ms (injectable for tests).
 * @param {(level: 'info' | 'warn' | 'error', message: string) => void} [options.onLog] - Log sink.
 * @param {(documentsSoFar: number, message: string) => void} [options.onProgress] - Progress sink.
 * @returns {object} The source context.
 */
export function buildContext({
  config,
  credentials,
  cursor,
  browser,
  timeoutMs,
  now,
  onLog,
  onProgress,
} = {}) {
  const budget = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const base = typeof now === 'number' ? now : Date.now();
  const softBudgetMs = Math.floor(budget * SOFT_BUDGET_RATIO);
  return {
    config: config || {},
    credentials: credentials || {},
    cursor: cursor ?? undefined,
    browser: browser ?? undefined,
    deadline: base + softBudgetMs,
    log: {
      info: (message) => onLog?.('info', String(message)),
      warn: (message) => onLog?.('warn', String(message)),
      error: (message) => onLog?.('error', String(message)),
    },
    progress: (documentsSoFar, message) => onProgress?.(documentsSoFar, String(message ?? '')),
  };
}

/**
 * Validate a single document against the per-document contract.
 *
 * @param {unknown} document - One entry of the `documents` array.
 * @param {number} index - Its position, for error messages.
 * @throws {InvalidSourceResponseError} If the document is malformed.
 */
function validateDocument(document, index) {
  if (document === null || typeof document !== 'object') {
    throw new InvalidSourceResponseError(`document at index ${index} is not an object`);
  }
  const record = /** @type {Record<string, unknown>} */ (document);
  for (const field of ['id', 'title']) {
    if (typeof record[field] !== 'string') {
      throw new InvalidSourceResponseError(
        `document at index ${index} has a non-string \`${field}\``,
      );
    }
  }
  // Audio-only documents carry an enclosure instead of text — the server
  // transcribes `audio_url` into the document body asynchronously.
  const hasText = typeof record.text === 'string';
  const hasAudio = typeof record.audio_url === 'string' && record.audio_url !== '';
  if (!hasText && !hasAudio) {
    throw new InvalidSourceResponseError(
      `document at index ${index} has neither \`text\` nor \`audio_url\``,
    );
  }
}

/**
 * Validate a source's return value against the result contract.
 *
 * @param {unknown} result - The value returned by `sync()` / `query()`.
 * @throws {InvalidSourceResponseError} If the shape is invalid.
 */
export function validateResult(result) {
  if (result === null || typeof result !== 'object') {
    throw new InvalidSourceResponseError(
      `source returned ${result === null ? 'null' : typeof result}, expected an object`,
    );
  }
  const { documents } = /** @type {{ documents?: unknown }} */ (result);
  if (!Array.isArray(documents)) {
    throw new InvalidSourceResponseError('source result is missing a `documents` array');
  }
  for (const [index, document] of documents.entries()) {
    validateDocument(document, index);
  }
}

/**
 * Resolve a source directory to the absolute file URL of its `index.mjs`.
 *
 * @param {string} sourcePath - Absolute or cwd-relative path to the source directory.
 * @returns {string} A `file://` URL for the source entry module.
 */
function sourceModuleUrl(sourcePath) {
  const abs = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(process.cwd(), sourcePath);
  return pathToFileURL(path.join(abs, 'index.mjs')).href;
}

/**
 * Import and run a source method, returning a normalized result.
 *
 * Executes a source method: pick `sync`/`query`, build the context, invoke,
 * validate the shape, and normalize to `{ documents, cursor, stats }` with a
 * measured `duration_ms`.
 *
 * @param {object} options - Run inputs.
 * @param {string} options.sourcePath - Path to the source directory.
 * @param {'sync' | 'query'} [options.method] - Method to invoke (default 'sync').
 * @param {Record<string, string>} [options.config] - Source config.
 * @param {Record<string, string>} [options.credentials] - Source credentials.
 * @param {unknown} [options.cursor] - Resume cursor.
 * @param {unknown} [options.browser] - Playwright browser context, or null.
 * @param {number} [options.timeoutMs] - Hard-timeout budget in ms.
 * @param {(level: 'info' | 'warn' | 'error', message: string) => void} [options.onLog] - Log sink.
 * @param {(documentsSoFar: number, message: string) => void} [options.onProgress] - Progress sink.
 * @returns {Promise<{ documents: object[], cursor: unknown, stats: object }>} Normalized result.
 * @throws {InvalidSourceResponseError} If the source lacks the method or returns an invalid shape.
 */
export async function runSource({
  sourcePath,
  method = 'sync',
  config,
  credentials,
  cursor,
  browser,
  timeoutMs,
  onLog,
  onProgress,
}) {
  const source = await import(sourceModuleUrl(sourcePath));
  const function_ = method === 'query' ? source.query : source.sync;
  if (typeof function_ !== 'function') {
    throw new InvalidSourceResponseError(`source does not export ${method}()`);
  }

  const context = buildContext({
    config,
    credentials,
    cursor,
    browser,
    timeoutMs,
    onLog,
    onProgress,
  });

  const startedAt = Date.now();
  const result = await function_(context);
  const durationMs = Date.now() - startedAt;

  validateResult(result);
  const documents = /** @type {object[]} */ (result.documents);
  return {
    documents,
    cursor: result.cursor ?? undefined,
    stats: { ...result.stats, fetched: documents.length, duration_ms: durationMs },
  };
}
