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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FetchLike } from '@ontrove/extend/source';
import type {
  ConfigValue,
  Cursor,
  Document,
  LogChannel,
  SourceContext,
  SourceSyncResult,
} from './types.js';

/** What {@link buildContext} needs to assemble the context a source runs against. */
export interface ContextInputs {
  /**
   * Source config. NOT `Record<string, string>`: a `url[]`/`text[]` field
   * arrives as an array, which is what every fan-out source reads.
   */
  config?: Record<string, ConfigValue>;
  /** Source credentials, surfaced to the adapter as `ctx.secret(name)`. */
  credentials?: Record<string, string>;
  /** Resume cursor from a prior run. */
  cursor?: unknown;
  /** Playwright browser context, or null. */
  browser?: unknown;
  /** Hard-timeout budget in ms. */
  timeoutMs?: number;
  /** Current epoch ms (injectable for tests). */
  now?: number;
  /** Log sink. */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Progress sink. */
  onProgress?: (documentsSoFar: number, message: string) => void;
}

/** {@link ContextInputs}, plus which source to run and which of its methods. */
export interface RunInputs extends Omit<ContextInputs, 'now'> {
  /** Path to the source directory. */
  sourcePath: string;
  /** Method to invoke (default 'sync'). */
  method?: 'sync' | 'query';
}

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
  /** @param message - Why the response is invalid. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSourceResponseError';
  }
}

/**
 * Build the `context` object passed to a source's `sync()` / `query()`.
 *
 * @param options - Context inputs.
 * @returns The source context.
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
}: ContextInputs = {}): SourceContext {
  const budget = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const base = typeof now === 'number' ? now : Date.now();
  const softBudgetMs = Math.floor(budget * SOFT_BUDGET_RATIO);
  const secrets = credentials || {};
  /**
   * The credential a source asked for by name, or `undefined`.
   *
   * The map goes in and only this comes out: a source cannot enumerate what it
   * was handed, so it cannot read a credential it never declared.
   *
   * @param name - The credential's name.
   * @returns Its value, when set.
   */
  const secret = (name: string): Promise<string | undefined> => Promise.resolve(secrets[name]);

  const context = {
    config: config || {},
    cursor: (cursor ?? undefined) as Cursor | undefined,
    browser: browser ?? undefined,
    deadline: base + softBudgetMs,
    secret,
    /**
     * {@link secret}, for a credential the source cannot proceed without.
     *
     * @param name - The credential's name.
     * @returns Its value.
     * @throws {Error} When it is unset or empty.
     */
    requireSecret: async (name: string): Promise<string> => {
      const value = await secret(name);
      if (value === undefined || value === '') {
        throw new Error(`Secret "${name}" is not set for this source.`);
      }
      return value;
    },
    // The seam's, so a source written against `ctx.fetch` behaves the same here
    // as it does in the cloud. The guard lives in the caller that supplies it;
    // locally there is nothing between the source and the network but this.
    fetch: ((url, init) => globalThis.fetch(url, init)) as FetchLike,
    now: () => new Date(base),
    log: makeLogChannel(onLog),
    /**
     * @param documentsSoFar - How many documents are done.
     * @param message - A line for a person watching.
     */
    progress: (documentsSoFar: number, message?: string) =>
      onProgress?.(documentsSoFar, String(message ?? '')),
  };
  return context;
}

/**
 * Build the callable log a source is handed.
 *
 * `LogChannel` is a FUNCTION with `info`/`warn`/`error` on it, not a bag of
 * three methods — a source may write `ctx.log('…')` and expect it to work.
 * Building only the three methods typechecks against nothing and fails at the
 * first bare call.
 *
 * @param onLog - Sink.
 * @returns The channel.
 */
function makeLogChannel(
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void,
): LogChannel {
  /** @param args - What to log. */
  const log = (...args: unknown[]) => onLog?.('info', args.map(String).join(' '));
  /** @param args - What to log. */
  log.info = (...args: unknown[]) => onLog?.('info', args.map(String).join(' '));
  /** @param args - What to log. */
  log.warn = (...args: unknown[]) => onLog?.('warn', args.map(String).join(' '));
  /** @param args - What to log. */
  log.error = (...args: unknown[]) => onLog?.('error', args.map(String).join(' '));
  return log;
}

/**
 * Validate a single document against the per-document contract.
 *
 * @param document - One entry of the `documents` array.
 * @param index - Its position, for error messages.
 * @throws {InvalidSourceResponseError} If the document is malformed.
 */
function validateDocument(document: unknown, index: number) {
  if (document === null || typeof document !== 'object') {
    throw new InvalidSourceResponseError(`document at index ${index} is not an object`);
  }
  const record = document as Record<string, unknown>;
  for (const field of ['id', 'title']) {
    if (typeof record[field] !== 'string') {
      throw new InvalidSourceResponseError(
        `document at index ${index} has a non-string \`${field}\``,
      );
    }
  }
  // A document may carry its body as inline `text`, an `audioUrl` enclosure
  // the server transcribes, or a `fileUrl` (e.g. a PDF) the server retains
  // and extracts — at least one is required.
  const hasText = typeof record.text === 'string';
  const hasAudio = typeof record.audioUrl === 'string' && record.audioUrl !== '';
  const hasFile = typeof record.fileUrl === 'string' && record.fileUrl !== '';
  if (!hasText && !hasAudio && !hasFile) {
    throw new InvalidSourceResponseError(
      `document at index ${index} has none of \`text\`, \`audioUrl\`, or \`fileUrl\``,
    );
  }
}

/**
 * Validate a source's return value against the result contract.
 *
 * @param result - The value returned by `sync()` / `query()`.
 * @throws {InvalidSourceResponseError} If the shape is invalid.
 */
export function validateResult(result: unknown) {
  if (result === null || typeof result !== 'object') {
    throw new InvalidSourceResponseError(
      `source returned ${result === null ? 'null' : typeof result}, expected an object`,
    );
  }
  const { documents } = result as { documents?: unknown };
  if (!Array.isArray(documents)) {
    throw new InvalidSourceResponseError('source result is missing a `documents` array');
  }
  for (const [index, document] of documents.entries()) {
    validateDocument(document, index);
  }
}

/**
 * The entry filenames a source directory may use, most-preferred first.
 *
 * The same list, in the same order, as the cloud bundler's and the Mac
 * runner's. `extension.ts` is the convention; the other two are what came
 * before. Keying on one literal filename is exactly how this harness stopped
 * being able to run any real source and said so only when someone tried it:
 * the fixtures still carried `index.mjs`, so the tests stayed green.
 */
const ENTRY_FILENAMES = ['extension.ts', 'index.ts', 'index.mjs'];

/**
 * Resolve a source directory to the absolute file URL of its entry module.
 *
 * Throws rather than returning a default: a missing entry that resolves to a
 * path anyway becomes an import error naming a file nobody wrote.
 *
 * @param sourcePath - Absolute or cwd-relative path to the source directory.
 * @returns A `file://` URL for the source entry module.
 * @throws {Error} When the directory holds none of {@link ENTRY_FILENAMES}.
 */
function sourceModuleUrl(sourcePath: string): string {
  const abs = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(process.cwd(), sourcePath);
  for (const name of ENTRY_FILENAMES) {
    const candidate = path.join(abs, name);
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  throw new Error(`no ${ENTRY_FILENAMES.join(' or ')} in ${abs} — is this a source directory?`);
}

/**
 * Import and run a source method, returning a normalized result.
 *
 * Executes a source method: pick `sync`/`query`, build the context, invoke,
 * validate the shape, and normalize to `{ documents, cursor, stats }` with a
 * measured `duration_ms`.
 *
 * @param options - Run inputs.
 * @returns Normalized result.
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
}: RunInputs): Promise<SourceSyncResult & { stats: Record<string, unknown> }> {
  const module_ = await import(sourceModuleUrl(sourcePath));
  // Either shape, and bound to its own declaration: `export default
  // defineSource({ …, sync })` is the convention, and a bare
  // `export async function sync` is what came before. The same unwrap the
  // cloud bundler does, so a source that runs here runs there.
  const source = module_.default ?? module_;
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
  const result = await function_.call(source, context);
  const durationMs = Date.now() - startedAt;

  validateResult(result);
  const documents = result.documents as Document[];
  return {
    documents,
    cursor: result.cursor ?? undefined,
    stats: {
      ...result.stats,
      fetched: documents.length,
      // Publish-date coverage, measured here so every source reports it the
      // same way whether or not its adapter tracks it (see `undatedStats()`).
      undated: documents.filter((document) => !document.date).length,
      duration_ms: durationMs,
    },
  };
}
