import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Both extensions: the source adapters are plain ESM and the toolkits are
    // TypeScript, and vitest loads either — which is the reason this repo runs
    // vitest at all rather than `bun test`. A parity test that imports the
    // `.ts` and the `.mjs` copy of one parser in the same file cannot run under
    // a runner that only sees one of them.
    include: ['**/*.test.mjs', '**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
