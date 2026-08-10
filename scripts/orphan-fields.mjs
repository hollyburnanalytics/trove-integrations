#!/usr/bin/env bun
/**
 * Fail the build on a declared tool input field that nothing reads.
 *
 * `tool()` gives the handler a typed `args`, but it cannot catch an ORPHANED
 * input field. `args` is a variable, so handing it to a helper triggers no
 * excess-property check, and a filter declared in the schema that no code ever
 * reads compiles perfectly. The cost is not a type error, it is a lie told to
 * the model: a tool advertises `has_transcript` in its schema, an agent passes
 * it, the API is called without it, and the results silently ignore the filter.
 *
 * So it is checked structurally instead:
 *
 *  1. Parse every `tool({ input: z.object({...}), handler })` out of the AST.
 *  2. Take the input's TOP-LEVEL field names.
 *  3. Look for each name in a READING position — `x.field`, a destructuring
 *     `{ field }`, or a quoted key `'field'` — anywhere in that toolkit, with
 *     the field's own declaration blanked out first.
 *
 * The search spans the toolkit DIRECTORY, not the file: handlers routinely pass
 * `args` straight to a query builder in a sibling module (cal-com's
 * `bookingQuery`, fred's `search.ts`, taddy's `search.ts`), and a file-scoped
 * check calls all of those orphans when they are the normal shape.
 *
 * A reading-position match rather than a bare name match, because a bare name
 * is far too weak: `limit` occurs in almost every schema in the repo, so any
 * `limit` would vouch for every other one.
 *
 * An `input` that is not a literal `z.object({...})` is reported as UNPARSED
 * rather than skipped — a check that quietly ignores what it cannot read is
 * worse than no check, because it reports success over a gap.
 *
 * Usage: bun scripts/orphan-fields.mjs [dir...]   (defaults to ./mcp)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import tsModule from 'typescript';

// typescript ships CJS; under bun the namespace can arrive wrapped in .default.
const ts = tsModule.ScriptTarget ? tsModule : tsModule.default;

/** Every file under `root` matching `pred`, recursively. */
function filesUnder(root, pred = () => true) {
  const out = [];
  (function walk(directory) {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const child = path.join(directory, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (pred(child)) out.push(child);
    }
  })(root);
  return out;
}

/**
 * The toolkit a file belongs to: the nearest ancestor holding a manifest.json.
 * Falls back to the file's own directory for a toolkit still without one.
 */
function toolkitRoot(file, roots) {
  let directory = path.dirname(file);
  for (let index = 0; index < 6; index++) {
    try {
      if (readdirSync(directory).includes('manifest.json')) return directory;
    } catch {
      // Unreadable — keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory || roots.includes(directory)) break;
    directory = parent;
  }
  return path.dirname(file);
}

/** Unwrap `z.object({...})` / `.extend({...})` through any chained modifiers. */
function zodObjectLiteral(node) {
  let current = node;
  for (let index = 0; index < 12 && current; index++) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'object' || callee.name.text === 'extend') &&
        current.arguments.length > 0 &&
        ts.isObjectLiteralExpression(current.arguments[0])
      ) {
        return current.arguments[0];
      }
      current = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  // Not a literal object — the caller reports it rather than assuming empty.
}

/** Does `field` appear anywhere in `text` in a position that READS it? */
function isRead(field, text) {
  const name = field.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`\\.${name}\\b|\\{[^}]*\\b${name}\\b[^{]*\\}|['"\`]${name}['"\`]`).test(text);
}

/** The name of a property, when it has a readable one. */
function propertyName(property) {
  const n = property.name;
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;
}

/** A `tool({...})` call's name and input node, or null if this isn't one. */
function toolSpec(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'tool' ||
    node.arguments.length === 0 ||
    !ts.isObjectLiteralExpression(node.arguments[0])
  ) {
    return;
  }
  let toolName = '(unnamed)';
  let inputNode;
  for (const property of node.arguments[0].properties) {
    const key = propertyName(property);
    if (!ts.isPropertyAssignment(property)) continue;
    if (key === 'name' && ts.isStringLiteral(property.initializer))
      toolName = property.initializer.text;
    if (key === 'input') inputNode = property.initializer;
  }
  return inputNode ? { toolName, inputNode } : undefined;
}

const roots = process.argv.slice(2);
const searchRoots = roots.length > 0 ? roots : ['mcp'];
const orphans = [];
const unparsed = [];
let checked = 0;

for (const root of searchRoots) {
  for (const file of filesUnder(root, (p) => p.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('tool(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const kit = toolkitRoot(file, searchRoots);
    const kitText = filesUnder(kit, (p) => /\.(ts|mjs)$/.test(p))
      .filter((p) => p !== file)
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');

    /** Check one tool's declared input fields against the toolkit. */
    const auditTool = ({ toolName, inputNode }) => {
      const lit = zodObjectLiteral(inputNode);
      if (!lit) {
        unparsed.push({ file, tool: toolName });
        return;
      }
      for (const property of lit.properties) {
        const field = propertyName(property);
        if (!field) continue;
        checked++;
        // The field's own declaration cannot vouch for itself.
        const own = text.slice(0, property.getStart(sf)) + text.slice(property.getEnd());
        if (!isRead(field, own) && !isRead(field, kitText)) {
          orphans.push({ file, tool: toolName, field });
        }
      }
    };

    (function visit(node) {
      const spec = toolSpec(node);
      if (spec) auditTool(spec);
      ts.forEachChild(node, visit);
    })(sf);
  }
}

const where = (f) => path.relative(process.cwd(), f);

if (orphans.length === 0 && unparsed.length === 0) {
  console.log(`orphan-fields: ${checked} declared input fields, all read.`);
  process.exit(0);
}

for (const o of orphans) {
  console.error(
    `${where(o.file)}: ${o.tool} declares "${o.field}" and nothing in the toolkit reads it.`,
  );
}
for (const u of unparsed) {
  console.error(
    `${where(u.file)}: ${u.tool} has an input this check cannot parse — read it by eye.`,
  );
}
console.error(
  `\norphan-fields: ${orphans.length} orphaned field(s), ${unparsed.length} unparsed, out of ${checked} checked.` +
    '\nA declared field nothing reads is a promise to the model that the tool silently breaks:' +
    '\nwire it up, or delete it from the schema.',
);
process.exit(1);
