import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      // Deliberately malformed source adapters used to test the harness's validation.
      'test/fixtures/**',
    ],
  },
  { ...sonarjs.configs.recommended, files: ['**/*.mjs'] },
  { ...unicorn.configs.recommended, files: ['**/*.mjs'] },
];
