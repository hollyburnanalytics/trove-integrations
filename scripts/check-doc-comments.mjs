#!/usr/bin/env node
/**
 * Fail when two single-line doc comments sit on consecutive lines.
 *
 * That shape means a declaration was inserted between a comment and the thing
 * it documented. JSDoc binds the nearer comment, so the inserted declaration
 * silently adopts a description of something else and the original declaration
 * is left undocumented.
 *
 * Twenty-one of these were introduced in one night by the hoists that satisfied
 * `unicorn/consistent-function-scoping` and `no-break-in-nested-loop`: each
 * extracted function landed between an existing `/** … *\/` and its subject.
 * Every gate passed on all of them — two stacked doc comments are valid
 * TypeScript, so `tsc`, `eslint`, `biome` and the whole suite have nothing to
 * say. They were found only because a finding count did not fall as far as the
 * number of edited sites, and someone went and read the file.
 *
 * This is the cheap half of that lesson: the shape is mechanically detectable,
 * so detect it rather than rely on noticing. The other half — an edit landing
 * in the wrong string rather than the wrong place — is not covered here and has
 * no gate at all.
 *
 * A legitimate two-line comment is written as one block (`/**` … `*\/` over
 * several lines), which this does not match.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Directories walked, relative to the repo root. */
const ROOTS = ['mcp', 'sources', 'scripts'];

/** A whole doc comment written on one line. */
const ONE_LINE_DOC = /^\s*\/\*\*.*\*\/\s*$/;

/**
 * Every `.ts` file under `dir`, recursively, excluding tests and dependencies.
 *
 * @param {string} dir - Directory to walk.
 * @returns {string[]} File paths.
 */
function typeScriptFiles(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...typeScriptFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const found = [];
for (const root of ROOTS) {
  let files;
  try {
    files = typeScriptFiles(root);
  } catch {
    continue; // a catalog need not have every root
  }
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const first = lines[i] ?? '';
      const second = lines[i + 1] ?? '';
      if (ONE_LINE_DOC.test(first) && ONE_LINE_DOC.test(second)) {
        found.push({ file, line: i + 1, orphan: first.trim(), keeps: second.trim() });
      }
    }
  }
}

if (found.length > 0) {
  console.error(`✗ ${found.length} orphaned doc comment(s) — a declaration was inserted between`);
  console.error(
    '  a comment and what it documented. Move the first comment down to its subject.\n',
  );
  for (const f of found) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`     orphaned: ${f.orphan}`);
    console.error(`     bound to: ${f.keeps}`);
  }
  process.exit(1);
}

console.log('✓ doc comments — none orphaned by an inserted declaration');
