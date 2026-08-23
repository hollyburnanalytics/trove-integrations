import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** A real `null` value derived without a `null` literal (unicorn/no-null). */
const NULL = JSON.parse('null');

import {
  buildContext,
  DEFAULT_TIMEOUT_MS,
  InvalidSourceResponseError,
  runSource,
  SOFT_BUDGET_RATIO,
  validateResult,
} from './harness.ts';

/**
 * Absolute path to a fixture source directory.
 *
 * @param name - The fixture's directory name.
 * @returns Its absolute path.
 */
function fixture(name: string): string {
  return path.resolve(import.meta.dirname, '../../test/fixtures/sources', name);
}

describe('buildContext', () => {
  it('sets the soft deadline at the budgeted fraction of the timeout', () => {
    const context = buildContext({ timeoutMs: 100_000, now: 1000 });
    expect(context.deadline).toBe(1000 + Math.floor(100_000 * SOFT_BUDGET_RATIO));
  });

  it('defaults the timeout budget when none is given', () => {
    const context = buildContext({ now: 0 });
    expect(context.deadline).toBe(Math.floor(DEFAULT_TIMEOUT_MS * SOFT_BUDGET_RATIO));
  });

  it('uses Date.now() as the base when now is not injected', () => {
    const before = Date.now();
    const context = buildContext({ timeoutMs: 10_000 });
    expect(context.deadline).toBeGreaterThanOrEqual(
      before + Math.floor(10_000 * SOFT_BUDGET_RATIO),
    );
  });

  it('defaults config to {} and leaves cursor/browser undefined', async () => {
    const context = buildContext();
    expect(context.config).toEqual({});
    expect(await context.secret('ANYTHING')).toBeUndefined();
    expect(context.cursor).toBeUndefined();
    expect(context.browser).toBeUndefined();
  });

  it('passes config, credentials, cursor, and browser through', async () => {
    const browser = { fake: true };
    const context = buildContext({
      config: { a: '1' },
      credentials: { k: 'secret' },
      cursor: 'c',
      browser,
    });
    expect(context.config).toEqual({ a: '1' });
    // Reachable only by name: the map goes in, and `secret(name)` is the only
    // way back out, so a source cannot read a credential it did not declare.
    expect(await context.secret('k')).toBe('secret');
    expect(await context.secret('not-declared')).toBeUndefined();
    expect(context.cursor).toBe('c');
    expect(context.browser).toBe(browser);
  });

  it('routes log levels to onLog, coercing the message to a string', () => {
    const onLog = vi.fn();
    const context = buildContext({ onLog });
    context.log.info('hi');
    context.log.warn('careful');
    context.log.error(String(123));
    expect(onLog.mock.calls).toEqual([
      ['info', 'hi'],
      ['warn', 'careful'],
      ['error', '123'],
    ]);
  });

  it('routes progress to onProgress, coercing a missing message to ""', () => {
    const onProgress = vi.fn();
    const context = buildContext({ onProgress });
    context.progress(3, 'scraping');
    context.progress(4, '');
    expect(onProgress.mock.calls).toEqual([
      [3, 'scraping'],
      [4, ''],
    ]);
  });

  it('is safe to call log/progress without sinks', () => {
    const context = buildContext();
    expect(() => {
      context.log.info('x');
      context.progress(0, 'y');
    }).not.toThrow();
  });
});

describe('validateResult', () => {
  it('accepts a well-formed result', () => {
    expect(() => validateResult({ documents: [{ id: '1', title: 'T', text: 'B' }] })).not.toThrow();
  });

  it('accepts an empty documents array', () => {
    expect(() => validateResult({ documents: [] })).not.toThrow();
  });

  it.each([
    ['null', NULL, 'expected an object'],
    ['a number', 7, 'expected an object'],
    ['a string', 'x', 'expected an object'],
  ])('rejects %s', (_label, value, expectedMessage) => {
    expect(() => validateResult(value)).toThrow(InvalidSourceResponseError);
    expect(() => validateResult(value)).toThrow(expectedMessage);
  });

  it('rejects a missing documents array', () => {
    expect(() => validateResult({})).toThrow('missing a `documents` array');
  });

  it('rejects a non-array documents field', () => {
    expect(() => validateResult({ documents: 'nope' })).toThrow('missing a `documents` array');
  });

  it('rejects a document that is not an object', () => {
    expect(() => validateResult({ documents: [NULL] })).toThrow('index 0 is not an object');
    expect(() => validateResult({ documents: [42] })).toThrow('index 0 is not an object');
  });

  it('rejects a document with a non-string required field', () => {
    expect(() => validateResult({ documents: [{ id: 1, title: 'b', text: 'c' }] })).toThrow(
      'non-string `id`',
    );
    expect(() => validateResult({ documents: [{ id: 'a', title: 2, text: 'c' }] })).toThrow(
      'non-string `title`',
    );
  });

  it('accepts an audio-only document (enclosure in place of text)', () => {
    expect(() =>
      validateResult({
        documents: [{ id: 'ep1', title: 'Episode', audioUrl: 'https://cdn.example/ep1.mp3' }],
      }),
    ).not.toThrow();
  });

  it('accepts a fileUrl-only document (a file the server retains and extracts)', () => {
    expect(() =>
      validateResult({
        documents: [{ id: 'p1', title: 'Paper', fileUrl: 'https://cdn.example/p1.pdf' }],
      }),
    ).not.toThrow();
  });

  it('rejects a document with no text, audioUrl, or fileUrl body', () => {
    expect(() => validateResult({ documents: [{ id: 'a', title: 'b' }] })).toThrow(
      'none of `text`, `audioUrl`, or `fileUrl`',
    );
    expect(() => validateResult({ documents: [{ id: 'a', title: 'b', text: 1 }] })).toThrow(
      'none of `text`, `audioUrl`, or `fileUrl`',
    );
    expect(() => validateResult({ documents: [{ id: 'a', title: 'b', audioUrl: '' }] })).toThrow(
      'none of `text`, `audioUrl`, or `fileUrl`',
    );
    expect(() => validateResult({ documents: [{ id: 'a', title: 'b', fileUrl: '' }] })).toThrow(
      'none of `text`, `audioUrl`, or `fileUrl`',
    );
  });
});

describe('runSource', () => {
  it('runs sync and normalizes documents, cursor, and stats', async () => {
    const result = await runSource({ sourcePath: fixture('echo') });
    expect(result.documents).toHaveLength(2);
    expect(result.cursor).toBe('echo-cursor');
    expect(result.stats?.fetched).toBe(2);
    expect(typeof result.stats?.duration_ms).toBe('number');
  });

  it('runs an extension.ts source that default-exports its declaration', async () => {
    // The shape every real adapter now uses. Kept separate from `echo` because
    // the harness resolving `mod.default ?? mod` and binding the receiver are
    // two different things, and neither is reachable through a bare-export
    // fixture. `this.id` in the document id is the receiver assertion.
    const result = await runSource({ sourcePath: fixture('echo-declared') });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.id).toBe('echo-declared-1');
  });

  it('names the entry filenames it looked for when a directory has none', async () => {
    await expect(runSource({ sourcePath: fixture('bad-shape/..') })).rejects.toThrow(
      /no extension\.ts or index\.ts or index\.mjs in/,
    );
  });

  it('resolves a cwd-relative source path', async () => {
    const result = await runSource({ sourcePath: 'test/fixtures/sources/echo' });
    expect(result.documents).toHaveLength(2);
  });

  it('runs the query method when asked', async () => {
    const result = await runSource({ sourcePath: fixture('echo'), method: 'query' });
    expect(result.documents).toHaveLength(1);
    expect(result.cursor).toBeUndefined();
    expect(result.stats?.fetched).toBe(1);
  });

  it('forwards onLog and onProgress to the source', async () => {
    const onLog = vi.fn();
    const onProgress = vi.fn();
    await runSource({ sourcePath: fixture('echo'), onLog, onProgress });
    expect(onLog).toHaveBeenCalledWith('info', 'echo: starting');
    expect(onProgress).toHaveBeenCalledWith(0, 'echo: working');
  });

  it('throws when the source does not export the method', async () => {
    await expect(runSource({ sourcePath: fixture('no-export') })).rejects.toThrow(
      InvalidSourceResponseError,
    );
    await expect(runSource({ sourcePath: fixture('no-export') })).rejects.toThrow(
      'does not export sync()',
    );
  });

  it.each([
    ['undefined', 'returned undefined'],
    ['documents-not-array', 'missing a `documents` array'],
    ['doc-not-object', 'index 0 is not an object'],
    ['bad-text', 'none of `text`, `audioUrl`, or `fileUrl`'],
  ])('rejects an invalid %s result', async (mode, expected) => {
    await expect(runSource({ sourcePath: fixture('bad-shape'), config: { mode } })).rejects.toThrow(
      expected,
    );
  });

  it('returns documents when within the soft budget', async () => {
    const result = await runSource({
      sourcePath: fixture('deadline-aware'),
      timeoutMs: 100_000,
    });
    expect(result.documents).toHaveLength(1);
  });

  it('honours a passed soft deadline and stops with no documents', async () => {
    // buildContext used directly so the deadline is deterministically in the past.
    const { sync } = await import(`${fixture('deadline-aware')}/index.mjs`);
    const context = buildContext({ timeoutMs: 1000, now: Date.now() - 10_000 });
    const result = await sync(context);
    expect(result.documents).toHaveLength(0);
    expect(result.stats?.remaining).toBe(1);
  });
});
