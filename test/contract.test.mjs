/**
 * Source contract tests.
 *
 * A data-driven sweep over every source in `sources/`. Unlike the per-source
 * unit tests (which mock `fetch` and exercise behavior), these assert the
 * invariants that must hold for ALL sources: a well-formed manifest, type-system
 * fields within the allowed sets, an `id` that matches the directory, a registry
 * entry, and — for implemented sources — an importable module that exports
 * `async function sync`. No network or fetch mocking is involved.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_SCHEDULES, validateSourceManifest } from '@ontrove/sdk';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const sourcesDirectory = path.join(repoRoot, 'sources');

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
    const indexPath = path.join(directory, 'index.mjs');
    sources.push({
      id,
      indexPath,
      implemented: existsSync(indexPath),
      manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    });
  }
  return sources;
}

const sources = discoverSources();
/** @type {{ sources: Array<{ id: string }> }} */
const registry = JSON.parse(readFileSync(path.join(repoRoot, 'registry.json'), 'utf8'));
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

    if (implemented) {
      it('exports an async sync(ctx) function', async () => {
        const module = await import(indexPath);
        expect(typeof module.sync).toBe('function');
      });
    }
  });
});
