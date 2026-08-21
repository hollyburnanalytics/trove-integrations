#!/usr/bin/env bun

/**
 * Audit the `meta-ads` toolkit against Meta's own generated SDK.
 *
 * The Marketing API has no OpenAPI document, but it has something nearly as
 * good: Meta generates the `facebook-python-business-sdk` from the same
 * internal schema that serves the API, and pins it to a Graph version. Every
 * field name, breakdown, date preset, attribution window and delivery status
 * the API accepts is a string literal in those generated classes.
 *
 * That makes the toolkit's one un-typecheckable surface checkable. A field name
 * is just a string in a query parameter: `tsc` is happy with `spendz`, every
 * test passes because the fixtures are ours, and the mistake only appears as an
 * error 100 on a live call — which fails the WHOLE request, not just that
 * field. So this compares what the toolkit declares against what the SDK says
 * exists, and fails on anything that is not there.
 *
 * It reports the reverse direction too — what the API offers that the toolkit
 * does not expose — as information rather than as a failure. Meta ships ~219
 * insights fields and 89 breakdowns; exposing all of them would be a worse
 * tool, not a more complete one. The number is there so the omission stays a
 * decision instead of an oversight.
 *
 * Usage:
 *   bun scripts/audit-meta-fields.mjs               # audit against the SDK on GitHub
 *   bun scripts/audit-meta-fields.mjs --verbose     # also list what is not exposed
 *   bun scripts/audit-meta-fields.mjs --from <dir>  # audit against already-downloaded
 *                                                   # adobject .py files (offline / CI)
 */

import { GRAPH_VERSION } from '../mcp/meta-ads/client.ts';
import {
  ACCOUNT_FIELDS,
  ATTRIBUTION_WINDOWS,
  BREAKDOWNS,
  DATE_PRESETS,
  ENTITY_FIELDS,
  ENTITY_STATUSES,
  fieldsFor,
  LEVELS,
  METRIC_GROUPS,
} from '../mcp/meta-ads/fields.ts';
import { SORTABLE } from '../mcp/meta-ads/insights.ts';

const SDK = 'https://raw.githubusercontent.com/facebook/facebook-python-business-sdk';
const verbose = process.argv.includes('--verbose');
const fromIndex = process.argv.indexOf('--from');
/** A directory of already-downloaded SDK modules, for an offline run. */
const localDir = fromIndex === -1 ? undefined : process.argv[fromIndex + 1];

/**
 * Read one generated SDK module, from disk when `--from` was given.
 *
 * @param {string} name - Module path under `facebook_business/`, e.g. `apiconfig`.
 * @returns {Promise<string>} The module's source.
 */
async function sdkModule(name) {
  if (localDir) return Bun.file(`${localDir}/${name}.py`).text();
  const url = `${SDK}/main/facebook_business/${name}.py`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

/**
 * One generated adobject module (`adsinsights`, `campaign`, …).
 *
 * @param {string} object - The adobject name.
 * @returns {Promise<string>} The module's source.
 */
const sdkSource = (object) => sdkModule(localDir ? object : `adobjects/${object}`);

/**
 * Pull `class Name:` → `{'VALUE', …}` out of a generated module.
 *
 * The generated classes are flat: a class line, then `NAME = 'value'` lines at
 * one indent deeper. Nothing else in these files has that shape.
 *
 * @param {string} source - A generated module's source.
 * @returns {Map<string, Set<string>>} Each nested class's literal values.
 */
function enums(source) {
  const found = new Map();
  let current;
  for (const line of source.split('\n')) {
    const className = /^ {4}class (\w+)/.exec(line);
    if (className) {
      current = className[1];
      found.set(current, new Set());
      continue;
    }
    if (/^ {4}\S/.test(line)) current = undefined;
    const member = /^ {8}(\w+) = '([^']*)'/.exec(line);
    if (member && current) found.get(current).add(member[2]);
  }
  return found;
}

/**
 * The SDK's declared API version, so a drift from our pin is visible.
 *
 * @returns {Promise<string>} The version the SDK generates against.
 */
async function sdkVersion() {
  const match = /'API_VERSION': '([^']+)'/.exec(await sdkModule('apiconfig'));
  return match?.[1] ?? 'unknown';
}

/**
 * One nested class's values, insisting it is actually there.
 *
 * A missing class must be loud. `Map#get` returning undefined would otherwise
 * audit every declared name against an empty set — which passes nothing and
 * reports success, the one outcome an audit must never produce.
 *
 * @param {Map<string, Set<string>>} classes - Parsed classes from one module.
 * @param {string} name - The class to read.
 * @returns {Set<string>} Its literal values.
 */
function enumOf(classes, name) {
  const values = classes.get(name);
  if (!values || values.size === 0) {
    throw new Error(`SDK class ${name} is missing or empty — the generated shape changed.`);
  }
  return values;
}

let failures = 0;

/**
 * Compare one declared set against the SDK's, and record any invalid member.
 *
 * @param {string} label - What is being audited.
 * @param {readonly string[]} declared - What the toolkit sends.
 * @param {Set<string>} allowed - What the SDK says exists.
 * @returns {void}
 */
function audit(label, declared, allowed) {
  const mine = [...new Set(declared)];
  const invalid = mine.filter((value) => !allowed.has(value));
  const missing = [...allowed].filter((value) => !mine.includes(value)).toSorted();
  const verdict = invalid.length > 0 ? `INVALID: ${invalid.join(', ')}` : 'ok';
  if (invalid.length > 0) failures += invalid.length;
  console.log(
    `${invalid.length > 0 ? '✗' : '✓'} ${label.padEnd(38)} ${String(mine.length).padStart(3)}/${String(
      allowed.size,
    ).padEnd(4)} ${verdict}`,
  );
  if (verbose && missing.length > 0) console.log(`    not exposed: ${missing.join(', ')}`);
}

const [version, insights, campaign, adset, ad, adaccount] = await Promise.all([
  sdkVersion(),
  sdkSource('adsinsights').then(enums),
  sdkSource('campaign').then(enums),
  sdkSource('adset').then(enums),
  sdkSource('ad').then(enums),
  sdkSource('adaccount').then(enums),
]);

console.log(`meta-ads pins Graph ${GRAPH_VERSION}; SDK on main declares ${version}\n`);
if (version !== GRAPH_VERSION) {
  console.log(
    `! The SDK has moved to ${version}. Names below are audited against THAT version, so a\n` +
      `  failure may mean the pin is stale rather than that the toolkit is wrong.\n`,
  );
}

audit('date_preset', DATE_PRESETS, enumOf(insights, 'DatePreset'));
audit('breakdowns', BREAKDOWNS, enumOf(insights, 'Breakdowns'));
audit(
  'action_attribution_windows',
  ATTRIBUTION_WINDOWS,
  enumOf(insights, 'ActionAttributionWindows'),
);
audit('level', LEVELS, enumOf(insights, 'Level'));
audit('sort_by', SORTABLE, enumOf(insights, 'Field'));
for (const level of LEVELS) {
  const groups = METRIC_GROUPS.filter((group) => group !== 'quality' || level === 'ad');
  audit(`insights fields @ ${level}`, fieldsFor(level, groups), enumOf(insights, 'Field'));
}
audit('campaign listing fields', ENTITY_FIELDS.campaign.split(','), enumOf(campaign, 'Field'));
audit('adset listing fields', ENTITY_FIELDS.adset.split(','), enumOf(adset, 'Field'));
audit('ad listing fields', ENTITY_FIELDS.ad.split(','), enumOf(ad, 'Field'));
audit('ad account fields', ACCOUNT_FIELDS.split(','), enumOf(adaccount, 'Field'));
audit(
  'effective_status',
  ENTITY_STATUSES,
  new Set([
    ...enumOf(campaign, 'EffectiveStatus'),
    ...enumOf(adset, 'EffectiveStatus'),
    ...enumOf(ad, 'EffectiveStatus'),
  ]),
);

console.log(
  failures === 0
    ? '\nEvery name meta-ads sends exists in the SDK.'
    : `\n${failures} name(s) the API would reject. Each one fails the whole request it appears in.`,
);
process.exit(failures === 0 ? 0 : 1);
