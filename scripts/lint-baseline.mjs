#!/usr/bin/env node
/**
 * Lint ratchet — contains existing debt so it can only shrink.
 *
 * Biome has no native baseline. This ~1-file harness closes that gap without a
 * second linter: it counts every WARNING-level Biome diagnostic (the ratcheted
 * rules — those that would otherwise fire on existing code) bucketed by rule,
 * plus the total suppression count, and compares to the committed
 * `lint-baseline.json`.
 *
 *   - ERROR-level rules are NOT tracked here — `biome check` (the `lint` script)
 *     already fails the build on them, so they are always 0. This tool governs
 *     only the "strict rules we're ratcheting toward clean".
 *   - A rule's count going ABOVE its baseline fails the build (new debt).
 *   - `--update` rewrites the baseline DOWN to the current low and drops any
 *     rule now at 0 (locking it clean). It never raises a number without an
 *     intentional, reviewable commit — the valve is one-way toward zero.
 *
 * Usage:
 *   bun run lint:baseline           # CI gate — fail on regression
 *   bun run lint:baseline --update  # ratchet the baseline down after paying debt
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE_PATH = 'lint-baseline.json';
const update = process.argv.includes('--update');

/** Count warning-level Biome diagnostics, bucketed by rule category. */
function biomeWarnCounts() {
  let raw;
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- dev tooling; same trust as any package.json script
    raw = execSync('bunx biome check . --reporter=json', {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], // drop biome's experimental-reporter stderr notice
    });
  } catch (error) {
    // biome exits non-zero only on ERROR diagnostics — those are the `lint`
    // gate's job, and mean the tree is dirty. Surface and stop.
    process.stderr.write(
      'biome reported error-level diagnostics — fix `bun run lint` first (this tool governs only ratcheted warnings).\n',
    );
    process.stderr.write(String(error.stdout ?? '').slice(0, 400));
    process.exit(2);
  }
  const diagnostics = JSON.parse(raw).diagnostics ?? [];
  const counts = {};
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'warning') continue;
    const rule = diagnostic.category ?? 'unknown';
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

/** Total `biome-ignore` suppressions in shipped code — a shrink-only number. */
function suppressionCount() {
  const out = execSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- dev tooling; same trust as any package.json script
    // --exclude this script: it names the marker in its own docs and grep.
    "grep -rho 'biome-ignore' mcp sources scripts bin --exclude-dir=node_modules --exclude=lint-baseline.mjs 2>/dev/null | wc -l",
    { encoding: 'utf8' },
  ).trim();
  return Number(out) || 0;
}

/** Sort object keys for a stable, diff-friendly baseline file. */
function sorted(object) {
  return Object.fromEntries(Object.entries(object).toSorted(([a], [b]) => a.localeCompare(b)));
}

const current = biomeWarnCounts();
current['suppressions/biome-ignore'] = suppressionCount();

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

if (update) {
  // Record the ACTUAL current counts: paying down debt writes the new low, and a
  // deliberate, justified increase writes the higher number. `--update` is a
  // manual, committed, reviewed action — that (not a Math.min clamp) is what keeps
  // a ceiling from rising by accident: a reviewer sees the number go up in the
  // diff. A rule now at 0 is dropped entirely, locking it clean.
  const next = {};
  for (const [key, count] of Object.entries(current)) {
    if (count > 0) next[key] = count;
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted(next), undefined, 2)}\n`);
  const raised = Object.keys(next).filter((key) => next[key] > (baseline[key] ?? 0));
  console.log(`✓ baseline written to ${BASELINE_PATH} (current counts).`);
  if (raised.length > 0) {
    console.log(
      `  ⚠ ceiling RAISED for: ${raised.join(', ')} — commit this deliberately; a reviewer will see it go up.`,
    );
  }
  process.exit(0);
}

const regressions = [];
const improvable = [];
for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
  const now = current[key] ?? 0;
  const cap = baseline[key] ?? 0;
  if (now > cap) regressions.push(`  ✗ ${key}: ${now} > baseline ${cap}  (+${now - cap})`);
  else if (now < cap) improvable.push(`  ↓ ${key}: ${now} < baseline ${cap}  (ratchet down)`);
}

if (regressions.length > 0) {
  console.error(`✗ lint ratchet — new debt introduced:\n${regressions.join('\n')}`);
  console.error(
    '\nRemove the new violations. If the increase is genuinely intended, run:\n  bun run lint:baseline -- --update\nand commit lint-baseline.json so a reviewer sees the deliberate raise.',
  );
  process.exit(1);
}

const tracked = Object.keys(current).length;
console.log(`✓ lint ratchet — no regression (${tracked} tracked rule${tracked === 1 ? '' : 's'}).`);
if (improvable.length > 0) {
  console.log('  debt was paid down — run `bun run lint:baseline -- --update` to lock it in:');
  console.log(improvable.join('\n'));
}
