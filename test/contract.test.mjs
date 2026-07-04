/**
 * Source contract tests.
 *
 * A data-driven sweep over every source in `sources/`. Unlike the per-source
 * unit tests (which mock `fetch` and exercise behavior), these assert the
 * invariants that must hold for ALL sources: a well-formed manifest, type-system
 * fields within the allowed sets, an `id`/`category` that match the directory, a
 * registry entry, and — for implemented sources — an importable module that
 * exports `async function sync`. No network or fetch mocking is involved.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_SCHEDULES, validateSourceTypeFields } from '../sources/lib/constants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const sourcesDirectory = path.join(repoRoot, 'sources');

/** Discover every source directory: sources/{category}/{id}/manifest.json. */
function discoverSources() {
  const sources = [];
  const categories = readdirSync(sourcesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'lib')
    .map((entry) => entry.name);

  for (const category of categories) {
    const categoryDirectory = path.join(sourcesDirectory, category);
    const ids = readdirSync(categoryDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const id of ids) {
      const directory = path.join(categoryDirectory, id);
      const manifestPath = path.join(directory, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const indexPath = path.join(directory, 'index.mjs');
      sources.push({
        id,
        category,
        indexPath,
        implemented: existsSync(indexPath),
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      });
    }
  }
  return sources;
}

const sources = discoverSources();
const registry = JSON.parse(readFileSync(path.join(repoRoot, 'registry.json'), 'utf8'));
const registryIds = new Set(registry.sources.map((entry) => entry.id));

describe('source contract', () => {
  it('discovers a non-trivial number of sources', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  describe.each(sources)('$category/$id', ({ id, category, manifest, implemented, indexPath }) => {
    it('manifest id and category match the directory', () => {
      expect(manifest.id).toBe(id);
      expect(manifest.category).toBe(category);
    });

    it('manifest has the required identity fields', () => {
      for (const field of ['id', 'name', 'description', 'status']) {
        expect(manifest[field], `missing "${field}"`).toBeTruthy();
      }
    });

    it('type-system fields are valid', () => {
      expect(validateSourceTypeFields(manifest, { implemented })).toEqual([]);
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
