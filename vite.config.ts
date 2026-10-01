import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
