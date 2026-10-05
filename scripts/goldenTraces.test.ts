import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_DIR, goldenFiles } from './goldenTraces';

// The Go port is verified against these fixtures, so they must be what the current TS sim produces:
// a sim change without `npm run golden` would leave the Go tests checking against stale truth.
describe('golden fixtures', () => {
  it('match a fresh regeneration byte for byte', () => {
    const { files } = goldenFiles();
    expect(readdirSync(GOLDEN_DIR).sort()).toEqual([...files.keys()].sort());
    for (const [name, text] of files) {
      expect(readFileSync(join(GOLDEN_DIR, name), 'utf8') === text, `${name} is stale: run npm run golden`).toBe(true);
    }
  }, 60_000);
});
