import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

/**
 * Short commit of a production build: GIT_COMMIT (the image build passes it, since .git is not in
 * the container context), else the checkout's HEAD; "dev" when neither is a commit hash, and for
 * the dev server and tests.
 */
function buildHash(production: boolean): string {
  if (!production) return 'dev';
  let commit = process.env.GIT_COMMIT ?? '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Not a git checkout, or no git: the build says "dev".
    }
  }
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : 'dev';
}

export default defineConfig(({ command }) => ({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(buildHash(command === 'build')),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
}));
