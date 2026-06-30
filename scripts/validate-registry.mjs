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
 *   6. connector_count matches actual count
 *
 * Usage:
 *   node scripts/validate-registry.mjs          # report-only
 *   node scripts/validate-registry.mjs --fix    # auto-fix and write registry.json
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONNECTOR_TYPE_FIELDS,
  VALID_SCHEDULES,
  validateConnectorTypeFields,
} from '../sources/lib/constants.mjs';

const { join } = path;

const ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(ROOT, 'registry.json');
const MARKETPLACE_PATH = join(ROOT, 'sources', 'marketplace.json');
// Dewey-style subject classification (folder name = manifest `category`).
const CATEGORIES = [
  '000-general',
  '070-news',
  '300-social-sciences',
  '330-economics',
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

// --- Discover all connectors from filesystem ---
function discoverConnectors() {
  const connectors = [];
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

      connectors.push({ manifest, hasCode, path, directory });
    }
  }
  return connectors;
}

// --- Load registry ---
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const registryById = new Map(registry.connectors.map((c) => [c.id, c]));

// --- Discover filesystem connectors ---
const fsConnectors = discoverConnectors();
const fsById = new Map(fsConnectors.map((c) => [c.manifest.id, c]));

// --- Check 0: marketplace identity ---
// A connector's cloud identity is `{marketplace.id}/{connector.id}` (category is
// NOT part of identity), so the marketplace must declare a stable id and every
// connector id must be unique across the whole marketplace — not just within its
// category. See docs/connector-taxonomy.md.
if (existsSync(MARKETPLACE_PATH)) {
  const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, 'utf8'));
  if (typeof marketplace.id === 'string' && marketplace.id.trim() !== '') {
    ok(`Marketplace id: ${marketplace.id}`);
  } else {
    warn('sources/marketplace.json must declare a non-empty string "id"');
  }
} else {
  warn('sources/marketplace.json is missing (declares the marketplace identity)');
}

const idCounts = new Map();
for (const c of fsConnectors) {
  const list = idCounts.get(c.manifest.id) ?? [];
  list.push(c.path);
  idCounts.set(c.manifest.id, list);
}
for (const [id, paths] of idCounts) {
  if (paths.length > 1) {
    warn(
      `Connector id "${id}" is used by ${paths.length} connectors (${paths.join(', ')}) — ids must be unique across the marketplace, since identity is {marketplace.id}/{id}`,
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
for (const { manifest, path } of fsConnectors) {
  if (manifest.schedule && !VALID_SCHEDULES.includes(manifest.schedule)) {
    warn(`${path}/manifest.json: invalid schedule "${manifest.schedule}"`);
  }
}

// --- Check 3b: connector type-system fields (kind/transport/watermark/documentSemantics) ---
// Implemented connectors are held to the MVP cut; stubs may declare deferred values.
for (const { manifest, hasCode, path } of fsConnectors) {
  for (const error of validateConnectorTypeFields(manifest, { implemented: hasCode })) {
    warn(`${path}/manifest.json: ${error}`);
  }
}

// Sync category + the type-system fields from manifest → registry entries.
for (const [id, regEntry] of registryById) {
  const fsEntry = fsById.get(id);
  if (!fsEntry) continue;
  for (const field of ['category', ...Object.keys(CONNECTOR_TYPE_FIELDS)]) {
    if (regEntry[field] !== fsEntry.manifest[field]) {
      warn(`${id}: registry ${field} out of sync with manifest`);
      if (fix) regEntry[field] = fsEntry.manifest[field];
    }
  }
  // `available: false` temporarily hides a built connector that needs user input
  // (config or login) we can't collect yet. Absent = available. Only mirror the
  // explicit false so the registry stays clean.
  const available = fsEntry.manifest.available;
  if (available === false && regEntry.available !== false) {
    warn(`${id}: registry missing available:false`);
    if (fix) regEntry.available = false;
  } else if (available !== false && 'available' in regEntry) {
    warn(`${id}: registry has stale available flag`);
    if (fix) Reflect.deleteProperty(regEntry, 'available');
  }
}

// --- Check 4: path consistency ---
for (const [id, regEntry] of registryById) {
  const fsEntry = fsById.get(id);
  if (!fsEntry) continue;

  if (regEntry.path !== fsEntry.path) {
    warn(`${id}: registry path is "${regEntry.path}" but actual path is "${fsEntry.path}"`);
    if (fix) regEntry.path = fsEntry.path;
  }
}

// --- Check 5: orphans ---
for (const [id, fsEntry] of fsById) {
  if (!registryById.has(id)) {
    warn(`Manifest "${id}" at ${fsEntry.path} not found in registry`);
    if (fix) {
      registry.connectors.push({
        ...fsEntry.manifest,
        path: fsEntry.path,
        has_code: fsEntry.hasCode,
      });
      ok(`Added "${id}" to registry`);
    }
  }
}

// --- Check 6b: categories list matches connectors actually present ---
const actualCategories = [...new Set(registry.connectors.map((c) => c.category))].toSorted();
if (JSON.stringify(registry.categories) !== JSON.stringify(actualCategories)) {
  const phantom = (registry.categories ?? []).filter((c) => !actualCategories.includes(c));
  const suffix = phantom.length > 0 ? ` (phantom: ${phantom.join(', ')})` : '';
  warn(`categories list is out of sync${suffix}`);
  if (fix) registry.categories = actualCategories;
}

// --- Check 6: connector_count ---
if (fix) {
  // Sort connectors alphabetically by id
  registry.connectors.sort((a, b) => a.id.localeCompare(b.id));
  registry.connector_count = registry.connectors.length;
  registry.updated_at = new Date().toISOString();
}

const expectedCount = registry.connectors.length;
if (registry.connector_count !== expectedCount) {
  warn(`connector_count is ${registry.connector_count} but there are ${expectedCount} entries`);
  if (fix) registry.connector_count = expectedCount;
}

// --- Output ---
if (issues.length === 0) {
  console.log(
    `✓ Registry is valid (${registry.connectors.length} connectors, ${fsConnectors.filter((c) => c.hasCode).length} implemented)`,
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
