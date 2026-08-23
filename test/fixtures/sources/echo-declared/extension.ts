import { defineSource } from '@ontrove/extend/source';
import type { SourceContext } from '../../../../sources/lib/types.js';

/**
 * Fixture source in the shape every real adapter now uses: `extension.ts`,
 * default-exporting a `defineSource` declaration whose `sync` is a *method*.
 *
 * The `echo` fixture next door is the older bare-named-export shape. Both are
 * here on purpose: the harness resolves `mod.default ?? mod` and binds the
 * receiver, and neither half of that is exercised by the other fixture. When
 * the catalog renamed to `extension.ts` the harness kept looking for
 * `index.mjs` and reading a named `sync` — the suite stayed green because
 * every fixture was still the old shape, and the CLI was dead for weeks.
 */
export default defineSource({
  id: 'echo-declared',
  name: 'Echo (declared)',
  description: 'Fixture source that emits one document from a declaration.',
  icon: '🔁',
  version: '0.1.0',
  author: 'Hollyburn Analytics Inc.',
  kind: 'scheduled-sync',
  transport: 'api',
  cursor: 'none',
  ingest: 'append',
  runsIn: 'mac',
  schedule: 'every 1 hour',
  status: 'implemented',
  needsBrowser: false,
  egress: [],
  egressNote: 'A fixture. It reaches nothing.',
  async sync(context: SourceContext) {
    context.log.info('echo-declared: starting');
    // `this` is the declaration, so a method-shaped sync that reaches for a
    // sibling would work. Reading `id` here is what proves the receiver survived.
    const documents = [{ id: `${this.id}-1`, title: 'Declared', text: 'hello' }];
    return { documents, cursor: undefined, stats: { fetched: documents.length } };
  },
});
