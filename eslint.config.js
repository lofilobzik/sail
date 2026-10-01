import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'polar-out', 'docs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // sim/ is pure math: no Three.js, no DOM, no other app layers.
    files: ['src/sim/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'sim/ must not import Three.js.' },
            {
              group: ['**/render/**', '**/input/**', '**/debug/**', '**/nav/**'],
              message: 'sim/ must not depend on app layers.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'requestAnimationFrame', 'performance'],
    },
  },
  {
    // Cloth and telltale math stays testable under Node without Three.js.
    files: ['src/render/cloth/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['three', 'three/*'], message: 'render/cloth must not import Three.js.' }] }],
    },
  },
);
