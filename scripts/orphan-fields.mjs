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
import { dirname, join, relative } from 'node:path';
import tsModule from 'typescript';

// typescript ships CJS; under bun the namespace can arrive wrapped in .default.
const ts = tsModule.ScriptTarget ? tsModule : tsModule.default;

/** Every file under `root` matching `pred`, recursively. */
function filesUnder(root, pred = () => true) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (pred(path)) out.push(path);
    }
  })(root);
  return out;
}

/**
 * The toolkit a file belongs to: the nearest ancestor holding a manifest.json.
 * Falls back to the file's own directory for a toolkit still without one.
 */
function toolkitRoot(file, roots) {
  let dir = dirname(file);
  for (let i = 0; i < 6; i++) {
    try {
      if (readdirSync(dir).includes('manifest.json')) return dir;
    } catch {
      // Unreadable — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir || roots.some((r) => dir === r)) break;
    dir = parent;
  }
  return dirname(file);
}

/** Unwrap `z.object({...})` / `.extend({...})` through any chained modifiers. */
function zodObjectLiteral(node) {
  let cur = node;
  for (let i = 0; i < 12 && cur; i++) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'object' || callee.name.text === 'extend') &&
        cur.arguments.length > 0 &&
        ts.isObjectLiteralExpression(cur.arguments[0])
      ) {
        return cur.arguments[0];
      }
      cur = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  return null;
}

/** Does `field` appear anywhere in `text` in a position that READS it? */
function isRead(field, text) {
  const name = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.${name}\\b|\\{[^}]*\\b${name}\\b[^{]*\\}|['"\`]${name}['"\`]`).test(text);
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

    (function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'tool' &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const spec = node.arguments[0];
        let toolName = '(unnamed)';
        let inputNode = null;
        for (const prop of spec.properties) {
          const key = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
          if (
            key === 'name' &&
            ts.isPropertyAssignment(prop) &&
            ts.isStringLiteral(prop.initializer)
          ) {
            toolName = prop.initializer.text;
          }
          if (key === 'input' && ts.isPropertyAssignment(prop)) inputNode = prop.initializer;
        }
        if (inputNode) {
          const lit = zodObjectLiteral(inputNode);
          if (!lit) {
            unparsed.push({ file, tool: toolName });
          } else {
            for (const prop of lit.properties) {
              const n = prop.name;
              if (!n || !(ts.isIdentifier(n) || ts.isStringLiteral(n))) continue;
              const field = n.text;
              checked++;
              const own = text.slice(0, prop.getStart(sf)) + text.slice(prop.getEnd());
              if (!isRead(field, own) && !isRead(field, kitText)) {
                orphans.push({ file, tool: toolName, field });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
}

const where = (f) => relative(process.cwd(), f);

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
  console.error(`${where(u.file)}: ${u.tool} has an input this check cannot parse — read it by eye.`);
}
console.error(
  `\norphan-fields: ${orphans.length} orphaned field(s), ${unparsed.length} unparsed, out of ${checked} checked.` +
    '\nA declared field nothing reads is a promise to the model that the tool silently breaks:' +
    '\nwire it up, or delete it from the schema.',
);
process.exit(1);
