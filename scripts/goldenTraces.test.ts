import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_DIR, goldenFiles } from './goldenTraces';

// Same bound the Go golden test uses (server/sim/golden_test.go). V8's Math functions differ in the
// last bits between platforms (macOS fixtures, Linux CI), so byte equality is too strict; a real sim
// change moves values by far more than this.
const ABS = 1e-9;
const REL = 1e-9;

/** Path of the first value that differs beyond the tolerance, or null when they agree. */
function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= ABS + REL * Math.max(Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a).sort();
    const other = Object.keys(b).sort();
    if (keys.join() !== other.join()) return `${path}: keys ${keys.join()} vs ${other.join()}`;
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

// The Go port is verified against these fixtures, so they must be what the current TS sim produces:
// a sim change without `npm run golden` would leave the Go tests checking against stale truth.
describe('golden fixtures', () => {
  it('match a fresh regeneration', () => {
    const { files } = goldenFiles();
    expect(readdirSync(GOLDEN_DIR).sort()).toEqual([...files.keys()].sort());
    for (const [name, text] of files) {
      const stale = firstDifference(JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')), JSON.parse(text));
      expect(stale, `${name} is stale (run npm run golden): ${stale}`).toBeNull();
    }
  }, 60_000);
});
