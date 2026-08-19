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
import { VALID_SCHEDULES, validateSourceManifest } from '@ontrove/sdk';

/** Directory provider modules that exist on disk, resolved once. */
const DIRECTORY_PROVIDER_DIR = new URL('../sources/lib/directories/', import.meta.url);

/**
 * Whether a directory provider module exists for `name`.
 *
 * @param {string} name - The provider named by a manifest field.
 * @returns {boolean} True when `sources/lib/directories/{name}.mjs` exists.
 */
function directoryProviderExists(name) {
  return existsSync(new URL(`${name}.mjs`, DIRECTORY_PROVIDER_DIR));
}

const { join } = path;

const ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(ROOT, 'registry.json');
const CATALOG_PATH = join(ROOT, 'sources', 'catalog.json');

const fix = process.argv.includes('--fix');
/** @type {string[]} */
const issues = [];
/** @type {string[]} */
const info = [];

/**
 * Record a problem.
 *
 * @param {string} message - What is wrong.
 */
function warn(message) {
  issues.push(message);
}
/**
 * Record something worth printing that is not a problem.
 *
 * @param {string} message - What held.
 */
function ok(message) {
  info.push(message);
}

// --- Discover all sources from filesystem ---
// One directory per source, directly under `sources/`. There is no subject
// folder above it: a source's only names are its id and its catalog.
function discoverSources() {
  /** @type {{ manifest: Record<string, any>, hasCode: boolean, path: string, directory: string }[]} */
  const sources = [];
  const sourceDirectories = readdirSync(join(ROOT, 'sources'));
  for (const name of sourceDirectories) {
    if (name === 'lib') continue;
    const directory = join(ROOT, 'sources', name);
    if (!statSync(directory).isDirectory()) continue;

    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const hasCode = existsSync(join(directory, 'index.mjs'));

    sources.push({ manifest, hasCode, path: `sources/${name}`, directory });
  }
  return sources;
}

// --- Load registry ---
/** @type {{ sources: Record<string, any>[], categories?: unknown, source_count?: number, updated_at?: string }} */
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const registryById = new Map(registry.sources.map((c) => [c.id, c]));

// --- Discover filesystem sources ---
const fsSources = discoverSources();
const fsById = new Map(fsSources.map((c) => [c.manifest.id, c]));

// --- Check 0: catalog identity ---
// A source's cloud identity is `{catalog.id}/{source.id}`, so the catalog must
// declare a stable id and every source id must be unique across the whole
// catalog. See docs/source-adapter-taxonomy.md.
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
      `Source id "${id}" is used by ${paths.length} sources (${paths.join(', ')}) — ids must be unique across the catalog, since a source's identity is its catalog id and its own id together`,
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
// One call, owned by `@ontrove/sdk`: identity (`id`/`name`/`version`), the
// credential lint over `config`, the four type-system fields (held to the MVP
// cut when the source has code), `location` + the cloud-eligibility predicate,
// and the optional `schedule`, `fanOut`, `formatting` and `directory`
// declarations.
//
// `directoryProviderExists` is injected rather than assumed, because only this
// script knows the repo layout — and a provider typo caught at build time beats
// one surfacing to a user as an empty search result.
for (const { manifest, hasCode, path } of fsSources) {
  const { errors } = validateSourceManifest(manifest, {
    implemented: hasCode,
    directoryProviderExists,
  });
  for (const error of errors) {
    warn(`${path}/manifest.json: ${error}`);
  }
}

/**
 * Report (and with `--fix`, correct) every registry field that disagrees with
 * the manifest.
 *
 * @param {string} id - The source id, for the message.
 * @param {Record<string, unknown>} regEntry - The registry's copy.
 * @param {Record<string, unknown>} desired - What the manifest says it should be.
 * @returns {void} Nothing; it warns, and writes when fixing.
 */
function syncEntryFields(id, regEntry, desired) {
  for (const [key, value] of Object.entries(desired)) {
    if (JSON.stringify(regEntry[key]) === JSON.stringify(value)) continue;
    warn(`${id}: registry ${key} out of sync with manifest`);
    if (fix) regEntry[key] = value;
  }
}

/**
 * Report (and with `--fix`, remove) registry keys the manifest no longer
 * declares — e.g. the renamed `auth`.
 *
 * @param {string} id - The source id, for the message.
 * @param {Record<string, unknown>} regEntry - The registry's copy.
 * @param {Record<string, unknown>} desired - What the manifest declares.
 * @returns {void} Nothing; it warns, and deletes when fixing.
 */
function dropStaleFields(id, regEntry, desired) {
  for (const key of Object.keys(regEntry)) {
    if (Object.hasOwn(desired, key) || DERIVED_KEYS.has(key)) continue;
    warn(`${id}: registry has stale field "${key}"`);
    if (fix) Reflect.deleteProperty(regEntry, key);
  }
}

// --- Check 3c: registry entries are a faithful mirror of their manifest ---
// The manifest is the source of truth for every descriptive field; the registry
// carries a copy plus the filesystem-derived `path`. Syncing all manifest fields
// (not a hand-picked list) kills drift — e.g. a stale `needsBrowser`/`version`,
// or a renamed key like the old `auth` — and carries new fields (location,
// fanOut, config) automatically. `status` and `has_code` are derived from the
// filesystem (checks 1–2), so they are excluded here.
const DERIVED_KEYS = new Set(['status', 'has_code']);
for (const [id, regEntry] of registryById) {
  const fsEntry = fsById.get(id);
  if (!fsEntry) continue;

  /** @type {Record<string, unknown>} */
  const desired = { ...fsEntry.manifest, path: fsEntry.path };
  for (const key of DERIVED_KEYS) delete desired[key];

  syncEntryFields(id, regEntry, desired);
  dropStaleFields(id, regEntry, desired);
}

// --- Check 5: orphans ---
for (const [id, fsEntry] of fsById) {
  if (registryById.has(id)) {
    continue;
  }

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

// --- Check 6b: the registry declares no grouping of its own ---
// Sources are a flat set. A `categories` list here would be a second taxonomy
// with nothing on disk to keep it honest.
if ('categories' in registry) {
  warn('registry has a "categories" list; sources are a flat set');
  if (fix) Reflect.deleteProperty(registry, 'categories');
}

// --- Check 6: source_count ---
if (fix) {
  // Sort sources alphabetically by id
  registry.sources.sort((a, b) => String(a.id).localeCompare(String(b.id)));
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

process.exit(!fix && issues.length > 0 ? 1 : 0);
