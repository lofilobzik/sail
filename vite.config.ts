import { execFile, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
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

/** Go sources are outside Vite's module graph; rebuild once after a burst of saves. */
function wasmRebuild(): Plugin {
  return {
    name: 'wasm-rebuild',
    configureServer(server) {
      const roots = ['server/sim', 'server/cmd/simwasm'].map((dir) => resolve(server.config.root, dir));
      let timer: NodeJS.Timeout | undefined;
      let building = false;
      let dirty = false;
      let closed = false;
      const build = (): void => {
        timer = undefined;
        if (closed) return;
        building = true;
        server.config.logger.info('physics wasm: building');
        execFile('npm', ['run', 'build:wasm'], { cwd: server.config.root }, (error, stdout, stderr) => {
          building = false;
          if (closed) return;
          if (error) server.config.logger.error(`physics wasm: build failed\n${stdout}${stderr}`);
          else {
            server.config.logger.info('physics wasm: built; reloading');
            server.ws.send({ type: 'full-reload' });
          }
          if (dirty) {
            dirty = false;
            build();
          }
        });
      };
      const changed = (file: string): void => {
        if (!file.endsWith('.go') || !roots.some((root) => file.startsWith(`${root}/`))) return;
        if (building) {
          dirty = true;
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(build, 300);
      };
      server.watcher.add(roots);
      server.watcher.on('add', changed).on('change', changed).on('unlink', changed);
      server.httpServer?.once('close', () => {
        closed = true;
        clearTimeout(timer);
        server.watcher.off('add', changed).off('change', changed).off('unlink', changed);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [wasmRebuild()],
  // The plugin reloads only after a successful build, never on partial/generated output.
  server: { watch: { ignored: ['**/public/wasm/**', '**/src/physics/wasm_exec.js'] } },
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
