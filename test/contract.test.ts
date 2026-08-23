/**
 * Source contract tests.
 *
 * A data-driven sweep over every source in `sources/`. Unlike the per-source
 * unit tests (which mock `fetch` and exercise behavior), these assert the
 * invariants that must hold for ALL sources: a well-formed manifest, type-system
 * fields within the allowed sets, an `id` that matches the directory, a registry
 * entry, and — for implemented sources — a module whose default export is the
 * `defineSource` declaration the manifest was generated from. No network or
 * fetch mocking is involved.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSourceManifest, VALID_SCHEDULES, validateSourceManifest } from '@ontrove/extend/source';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const sourcesDirectory = path.join(repoRoot, 'sources');

/**
 * A source's entry module, by the names the convention has used.
 *
 * Keyed on a LIST rather than the literal `index.mjs` it was, because
 * `implemented` gates the per-source assertions below: a source whose entry
 * this cannot find is not reported as broken, it is silently skipped, and the
 * suite stays green while checking less. The port to `extension.ts` took 32
 * assertions out of this file that way before the test COUNT gave it away.
 *
 * @param directory - The source directory.
 * @returns Absolute path to the entry, or `null` when absent.
 */
function entryPath(directory: string): string | null {
  for (const name of ['extension.ts', 'index.ts', 'index.mjs']) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Discover every source directory: sources/{id}/manifest.json. */
function discoverSources() {
  const sources = [];
  const ids = readdirSync(sourcesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'lib')
    .map((entry) => entry.name);

  for (const id of ids) {
    const directory = path.join(sourcesDirectory, id);
    const manifestPath = path.join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const indexPath = entryPath(directory);
    sources.push({
      id,
      indexPath,
      implemented: indexPath !== null,
      manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    });
  }
  return sources;
}

const sources = discoverSources();
const registry: { sources: Array<{ id: string }> } = JSON.parse(
  readFileSync(path.join(repoRoot, 'registry.json'), 'utf8'),
);
const registryIds = new Set(registry.sources.map((entry) => entry.id));

describe('source contract', () => {
  it('discovers a non-trivial number of sources', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(sources)('$id', ({ id, manifest, implemented, indexPath }) => {
    it('manifest id matches the directory', () => {
      expect(manifest.id).toBe(id);
    });

    it('manifest has the required identity fields', () => {
      for (const field of ['id', 'name', 'description', 'status']) {
        expect(manifest[field], `missing "${field}"`).toBeTruthy();
      }
    });

    it('manifest invariants (identity, type system, location, fanOut) are valid', () => {
      // `implemented` is passed, not inferred, and passing it at all is what
      // makes the five declarations required — this is a catalog, so a source
      // that has not said how it collects is incomplete rather than unfinished.
      // The directory provider check is left to `scripts/validate-registry.mjs`,
      // which is the one that knows what is on disk.
      expect(validateSourceManifest(manifest, { implemented }).errors).toEqual([]);
    });

    it('schedule (when present) is one of the allowed values', () => {
      if (manifest.schedule !== undefined) {
        expect(VALID_SCHEDULES).toContain(manifest.schedule);
      }
    });

    it('is listed in registry.json', () => {
      expect(registryIds.has(id)).toBe(true);
    });

    if (implemented && indexPath !== null) {
      // Both halves of the same fact, because `implemented` is derived from
      // `indexPath` but TypeScript cannot see that across the destructure.
      const entry = indexPath;

      it('default-exports a source declaration with an async sync(ctx)', async () => {
        const module = await import(entry);
        // The default export is what `defineSource` returned, so importing the
        // module has already run the eager manifest validation. Reaching here
        // at all is half the assertion.
        expect(typeof module.default?.sync).toBe('function');
      });

      it('manifest.json matches the declaration it is generated from', async () => {
        const module = await import(entry);
        // The committed manifest is an artifact of the code (`toSourceManifest`),
        // and the readers that need it — Trove's catalog build, the Mac app —
        // cannot execute the source to derive it. Nothing else notices when the
        // declaration changes and the file is not regenerated, so this does.
        expect(toSourceManifest(module.default)).toEqual(manifest);
      });
    }
  });
});
