#!/usr/bin/env bun

/**
 * Validates registry.json against the filesystem and manifest files.
 *
 * Checks:
 *   1. has_code matches whether index.mjs exists
 *   2. status: implemented ↔ has_code: true consistency
 *   3. schedule values are from the allowed set
 *   4. path field matches actual directory
 *   5. Orphans: manifests not in registry, registry entries with no manifest
 *   6. source_count matches actual count
 *
 * Usage:
 *   node scripts/validate-registry.mjs          # report-only
 *   node scripts/validate-registry.mjs --fix    # auto-fix and write registry.json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VALID_SCHEDULES, validateManifest } from '../sources/lib/constants.mjs';

const { join } = path;

const ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(ROOT, 'registry.json');
const CATALOG_PATH = join(ROOT, 'sources', 'catalog.json');
// Dewey-style subject classification (folder name = manifest `category`).
const CATEGORIES = [
  '000-general',
  '070-news',
  '300-social-sciences',
  '330-economics',
  '350-public-administration',
  '500-science',
  '600-technology',
  '650-business',
];

const fix = process.argv.includes('--fix');
const issues = [];
const info = [];

function warn(message) {
  issues.push(message);
}
function ok(message) {
  info.push(message);
}

// --- Discover all sources from filesystem ---
function discoverSources() {
  const sources = [];
  for (const category of CATEGORIES) {
    const categoryDirectory = join(ROOT, 'sources', category);
    if (!existsSync(categoryDirectory)) continue;

    for (const name of readdirSync(categoryDirectory)) {
      const directory = join(categoryDirectory, name);
      if (!statSync(directory).isDirectory()) continue;

      const manifestPath = join(directory, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const hasCode = existsSync(join(directory, 'index.mjs'));
      const path = `sources/${category}/${name}`;

      sources.push({ manifest, hasCode, path, directory });
    }
  }
  return sources;
}

// --- Load registry ---
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const registryById = new Map(registry.sources.map((c) => [c.id, c]));

// --- Discover filesystem sources ---
const fsSources = discoverSources();
const fsById = new Map(fsSources.map((c) => [c.manifest.id, c]));

// --- Check 0: catalog identity ---
// A source's cloud identity is `{catalog.id}/{source.id}` (category is
// NOT part of identity), so the catalog must declare a stable id and every
// source id must be unique across the whole catalog — not just within its
// category. See docs/source-adapter-taxonomy.md.
if (existsSync(CATALOG_PATH)) {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  if (typeof catalog.id === 'string' && catalog.id.trim() !== '') {
    ok(`Catalog id: ${catalog.id}`);
  } else {
    warn('sources/catalog.json must declare a non-empty string "id"');
  }
} else {
  warn('sources/catalog.json is missing (declares the catalog identity)');
}

const idCounts = new Map();
for (const c of fsSources) {
  const list = idCounts.get(c.manifest.id) ?? [];
  list.push(c.path);
  idCounts.set(c.manifest.id, list);
}
for (const [id, paths] of idCounts) {
  if (paths.length > 1) {
    warn(
      `Source id "${id}" is used by ${paths.length} sources (${paths.join(', ')}) — ids must be unique across the catalog, since identity is {catalog.id}/{id}`,
    );
  }
}

// --- Check 1: has_code matches filesystem ---
for (const [id, regEntry] of registryById) {
  const fsEntry = fsById.get(id);
  if (!fsEntry) {
    warn(`Registry has "${id}" but no manifest found on filesystem`);
    continue;
  }

  if (regEntry.has_code !== fsEntry.hasCode) {
    warn(
      `${id}: has_code is ${regEntry.has_code} in registry but index.mjs ${fsEntry.hasCode ? 'exists' : 'does not exist'}`,
    );
    if (fix) regEntry.has_code = fsEntry.hasCode;
  }
}

// --- Check 2: status ↔ has_code consistency ---
for (const [id, regEntry] of registryById) {
  const fsEntry = fsById.get(id);
  if (!fsEntry) continue;

  if (fsEntry.hasCode && regEntry.status !== 'implemented') {
    warn(`${id}: has code but status is "${regEntry.status}" (should be "implemented")`);
    if (fix) regEntry.status = 'implemented';
  }
  if (!fsEntry.hasCode && regEntry.status === 'implemented') {
    warn(`${id}: status is "implemented" but no index.mjs exists`);
    if (fix) regEntry.status = 'stub';
  }
}

// --- Check 3: schedule validation ---
for (const [id, regEntry] of registryById) {
  if (regEntry.schedule && !VALID_SCHEDULES.includes(regEntry.schedule)) {
    warn(`${id}: invalid schedule "${regEntry.schedule}". Valid: ${VALID_SCHEDULES.join(', ')}`);
  }
}

// Also check manifests directly
for (const { manifest, path } of fsSources) {
  if (manifest.schedule && !VALID_SCHEDULES.includes(manifest.schedule)) {
    warn(`${path}/manifest.json: invalid schedule "${manifest.schedule}"`);
  }
}

// --- Check 3b: cross-cutting manifest invariants ---
// Type-system fields (kind/transport/watermark/documentSemantics, held to the
// MVP cut when implemented), `location` + the cloud-eligibility predicate, and
// the optional `fanOut` reference. See sources/lib/constants.mjs.
for (const { manifest, hasCode, path } of fsSources) {
  for (const error of validateManifest(manifest, { implemented: hasCode })) {
    warn(`${path}/manifest.json: ${error}`);
  }
}

// --- Check 3c: registry entries are a faithful mirror of their manifest ---
// The manifest is the source of truth for every descriptive field; the registry
// carries a copy plus the filesystem-derived `path`. Syncing all manifest fields
// (not a hand-picked list) kills drift — e.g. a stale `needs_browser`/`version`,
// or a renamed key like the old `auth` — and carries new fields (location,
// fanOut, config) automatically. `status` and `has_code` are derived from the
// filesystem (checks 1–2), so they are excluded here.
const DERIVED_KEYS = new Set(['status', 'has_code']);
for (const [id, regEntry] of registryById) {
  const fsEntry = fsById.get(id);
  if (!fsEntry) continue;

  const desired = { ...fsEntry.manifest, path: fsEntry.path };
  for (const key of DERIVED_KEYS) delete desired[key];

  for (const [key, value] of Object.entries(desired)) {
    if (JSON.stringify(regEntry[key]) !== JSON.stringify(value)) {
      warn(`${id}: registry ${key} out of sync with manifest`);
      if (fix) regEntry[key] = value;
    }
  }
  // Drop registry keys the manifest no longer declares (e.g. the renamed `auth`).
  for (const key of Object.keys(regEntry)) {
    if (!(key in desired) && !DERIVED_KEYS.has(key)) {
      warn(`${id}: registry has stale field "${key}"`);
      if (fix) Reflect.deleteProperty(regEntry, key);
    }
  }
}

// --- Check 5: orphans ---
for (const [id, fsEntry] of fsById) {
  if (!registryById.has(id)) {
    warn(`Manifest "${id}" at ${fsEntry.path} not found in registry`);
    if (fix) {
      registry.sources.push({
        ...fsEntry.manifest,
        path: fsEntry.path,
        has_code: fsEntry.hasCode,
      });
      ok(`Added "${id}" to registry`);
    }
  }
}

// --- Check 6b: categories list matches sources actually present ---
const actualCategories = [...new Set(registry.sources.map((c) => c.category))].toSorted();
if (JSON.stringify(registry.categories) !== JSON.stringify(actualCategories)) {
  const phantom = (registry.categories ?? []).filter((c) => !actualCategories.includes(c));
  const suffix = phantom.length > 0 ? ` (phantom: ${phantom.join(', ')})` : '';
  warn(`categories list is out of sync${suffix}`);
  if (fix) registry.categories = actualCategories;
}

// --- Check 6: source_count ---
if (fix) {
  // Sort sources alphabetically by id
  registry.sources.sort((a, b) => a.id.localeCompare(b.id));
  registry.source_count = registry.sources.length;
  registry.updated_at = new Date().toISOString();
}

const expectedCount = registry.sources.length;
if (registry.source_count !== expectedCount) {
  warn(`source_count is ${registry.source_count} but there are ${expectedCount} entries`);
  if (fix) registry.source_count = expectedCount;
}

// --- Output ---
if (issues.length === 0) {
  console.log(
    `✓ Registry is valid (${registry.sources.length} sources, ${fsSources.filter((c) => c.hasCode).length} implemented)`,
  );
} else {
  console.log(`Found ${issues.length} issue(s):\n`);
  for (const issue of issues) {
    console.log(`  ✗ ${issue}`);
  }
}

for (const message of info) {
  console.log(`  → ${message}`);
}

if (fix && issues.length > 0) {
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, undefined, 2)}\n`);
  console.log(`\n✓ Fixed ${issues.length} issue(s) and wrote registry.json`);
}

process.exit(issues.length > 0 && !fix ? 1 : 0);
