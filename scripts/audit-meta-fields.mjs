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
 * It checks one more thing the names alone cannot: Meta types costs, averages
 * and ratios with the SAME `list<AdsActionStats>` shape as counts, so the
 * toolkit keeps an allowlist of the lists it is allowed to ADD UP. A name on
 * that list that is not list-typed upstream is a stale claim, and this fails on
 * it.
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
  fieldsFor,
  LEVELS,
  METRIC_GROUPS,
  STATUSES_BY_LEVEL,
} from '../mcp/meta-ads/fields.ts';
import { SORTABLE } from '../mcp/meta-ads/insights.ts';
import { SUMMABLE_LISTS } from '../mcp/meta-ads/rows.ts';

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
 * The declared type of every AdsInsights field, from the generated
 * `_field_types` map — the only place that says a field arrives as a list.
 *
 * @param {string} source - The adsinsights module source.
 * @returns {Map<string, string>} Field name → declared type.
 */
function fieldTypes(source) {
  /** @type {Map<string, string>} */
  const types = new Map();
  for (const match of source.matchAll(/^ {8}'(\w+)': '([^']*)',/gm)) {
    if (match[1] !== undefined && match[2] !== undefined) types.set(match[1], match[2]);
  }
  return types;
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
// Per level, never unioned: the three enums differ (6/7/12 values), so a union
// would vouch for an ad-only status on the campaign edge — which is exactly the
// mistake this audit exists to catch.
audit('campaign effective_status', STATUSES_BY_LEVEL.campaign, enumOf(campaign, 'EffectiveStatus'));
audit('adset effective_status', STATUSES_BY_LEVEL.adset, enumOf(adset, 'EffectiveStatus'));
audit('ad effective_status', STATUSES_BY_LEVEL.ad, enumOf(ad, 'EffectiveStatus'));

// Costs, averages and ratios wear the same list shape as counts, so the one
// thing a name check cannot see is whether the toolkit will ADD one up.
const types = fieldTypes(await sdkSource('adsinsights'));
const stale = [...SUMMABLE_LISTS].filter((field) => !(types.get(field) ?? '').startsWith('list<'));
if (stale.length > 0) {
  failures += stale.length;
  console.log(
    `\n✗ SUMMABLE_LISTS names a field that is not list-typed upstream: ${stale.join(', ')}`,
  );
} else {
  console.log(`\n✓ every summable list (${SUMMABLE_LISTS.size}) is list-typed upstream`);
}

if (verbose) {
  const requested = new Set(
    LEVELS.flatMap((level) =>
      fieldsFor(
        level,
        METRIC_GROUPS.filter((group) => group !== 'quality' || level === 'ad'),
      ),
    ),
  );
  console.log('\n  list-typed fields requested, and how they combine:');
  for (const field of [...requested].toSorted()) {
    if (!(types.get(field) ?? '').startsWith('list<')) continue;
    console.log(`    ${field.padEnd(34)} ${SUMMABLE_LISTS.has(field) ? 'summed' : 'per-type map'}`);
  }
}

console.log(
  failures === 0
    ? '\nEvery name meta-ads sends exists in the SDK.'
    : `\n${failures} problem(s). An invalid name fails the whole request it appears in.`,
);
process.exit(failures === 0 ? 0 : 1);
