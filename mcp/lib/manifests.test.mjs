/**
 * Every toolkit's committed `manifest.json`, checked against the declaration
 * that produced it.
 *
 * Sources have had this since `defineSource` shipped — it returns the source
 * object itself, so a test can regenerate the manifest from the code and
 * compare (`sources/lib/manifests.test.ts`). Toolkits could not:
 * `defineToolkit` returned only `tools` and `handle`, so the declaration was
 * unreachable the moment the module finished loading, and `toToolkitManifest`
 * sat in the SDK with no way to be called on a real toolkit. These manifests
 * were maintained by hand against nothing.
 *
 * That is not tidiness. `scripts/deploy-mcp.mjs` reads `egress`, `scopes` and
 * `secrets` off the committed file, not out of the code — so tightening
 * `egress` in `extension.ts` and forgetting the JSON deploys a server still
 * holding the wider allowlist, and nothing anywhere says so. The file is a
 * permissions grant; this is what keeps it honest.
 *
 * Whole-manifest, not field-by-field: the failure being prevented is a toolkit
 * quietly declaring something its code no longer says, and a sampled check
 * cannot know which field that will be.
 *
 * `.mjs` rather than `.ts` deliberately — `mcp/tsconfig.json` targets Workers
 * and carries no node types, which is why every test under `mcp/` is `.mjs`.
 * Typing them is its own project, not a rider on this one.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The toolkit root — this file lives in `mcp/lib/`. */
const MCP_DIR = path.join(import.meta.dirname, '..');

/**
 * Every toolkit directory, by id.
 *
 * Read from disk rather than listed here, because a hand-maintained list is
 * the same defect one level up: a toolkit added without touching this file
 * would be checked by nothing and look fine.
 *
 * @returns {string[]} The toolkit directory names, sorted.
 */
function toolkitDirectories() {
  return readdirSync(MCP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'lib')
    .map((entry) => entry.name)
    .toSorted();
}

/**
 * Read one toolkit's committed manifest.
 *
 * @param {string} id - The toolkit directory's name.
 * @returns {Record<string, unknown>} The parsed manifest.
 */
function readManifest(id) {
  return JSON.parse(readFileSync(path.join(MCP_DIR, id, 'manifest.json'), 'utf8'));
}

/**
 * Import a toolkit and return the manifest its declaration produces.
 *
 * `module.default ?? module` is the same unwrap the cloud bundler and the Mac
 * runner do — an `extension.ts` default-exports the compiled server.
 *
 * @param {string} id - The toolkit directory's name.
 * @returns {Promise<Record<string, unknown>>} The manifest the code declares.
 */
async function declaredManifest(id) {
  const module_ = await import(path.join(MCP_DIR, id, 'extension.ts'));
  const server = module_.default ?? module_;
  return server.manifest;
}

const TOOLKITS = toolkitDirectories();

describe('every toolkit manifest is generated from its code', () => {
  it('finds the toolkits', () => {
    // A discovery bug makes every case below vacuous: an empty list passes a
    // per-toolkit suite in silence, which is the shape of gate this file
    // exists to replace.
    expect(TOOLKITS.length).toBeGreaterThan(0);
  });

  it.each(TOOLKITS)('%s', async (id) => {
    expect(await declaredManifest(id)).toEqual(readManifest(id));
  });
});
