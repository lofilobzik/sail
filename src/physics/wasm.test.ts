import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Physics } from './bridge';
import { loadPhysics } from './load';
import type { BoatState, Controls, SimConfig } from './types';

interface GoldenTrace {
  config: SimConfig;
  initial: BoatState;
  controls: Controls[];
  record: { step: number; state: BoatState; diag: Record<string, unknown> }[];
}

function compare(got: unknown, want: unknown, path: string): void {
  if (typeof want === 'number') {
    expect(typeof got, path).toBe('number');
    expect(Math.abs((got as number) - want), path).toBeLessThanOrEqual(1e-9 + 1e-9 * Math.abs(want));
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got), path).toBe(true);
    const values = got as unknown[];
    expect(values.length, path).toBe(want.length);
    for (let i = 0; i < want.length; i++) compare(values[i], want[i], `${path}[${i}]`);
  } else if (want !== null && typeof want === 'object') {
    expect(got, path).not.toBeNull();
    expect(typeof got, path).toBe('object');
    const values = got as Record<string, unknown>;
    for (const [key, value] of Object.entries(want)) compare(values[key], value, `${path}.${key}`);
  } else {
    expect(got, path).toBe(want);
  }
}

function replayTrace(physics: Physics, trace: GoldenTrace, finalStep: number): BoatState {
  physics.setConfig(trace.config);
  let state = { ...trace.initial };
  const records = new Map(trace.record.map((record) => [record.step, record]));
  expect(trace.controls.length).toBeGreaterThan(finalStep);
  expect(records.has(finalStep)).toBe(true);
  for (let i = 0; i <= finalStep; i++) {
    state = physics.step(state, trace.controls[i]!);
    const record = records.get(i);
    if (record) compare(state, record.state, `step ${i}.state`);
  }
  compare(physics.diagnostics(), records.get(finalStep)!.diag, `step ${finalStep}.diagnostics`);
  return state;
}

describe('Go WebAssembly physics boundary', () => {
  let physics: Physics;
  let trace: GoldenTrace;

  beforeAll(async () => {
    const [wasm, fixture] = await Promise.all([
      readFile(new URL('../../public/wasm/sim.wasm', import.meta.url)),
      readFile(new URL('../../server/sim/testdata/golden/trace-browser.json', import.meta.url), 'utf8'),
    ]);
    physics = await loadPhysics(wasm);
    trace = JSON.parse(fixture) as GoldenTrace;
  });

  it('replays the browser trace and matches its recorded states and final diagnostics', () => {
    // The fixture is sparse after step 119 and has no step 599 record.
    // Replay through step 600 (601 inputs) to check a recorded endpoint.
    replayTrace(physics, trace, 600);
  });

  // MIGRATION-ONLY: frozen TS sim output; delete in step 3b once step 3 is approved.
  it('replays the frozen TS browser trace and matches states and final diagnostics', async () => {
    const fixture = await readFile(new URL('../../server/sim/testdata/golden-ts/trace-browser.json', import.meta.url), 'utf8');
    replayTrace(physics, JSON.parse(fixture) as GoldenTrace, 600);
  });

  it('replays batched controls in order and can return to individual steps', () => {
    const controls = trace.controls.slice(0, 120);
    const expected = replayTrace(physics, trace, 119);
    const diagnostics = physics.diagnostics();
    const actual = physics.stepMany(trace.initial, controls);
    compare(actual, expected, 'batch.state');
    compare(physics.diagnostics(), diagnostics, 'batch.diagnostics');
    compare(physics.stepMany(actual, []), actual, 'empty batch');
    const input = trace.controls[120]!;
    compare(physics.step(actual, input), trace.record.find((record) => record.step === 120)!.state, 'single after batch');
    expect(physics.clampControls({ tiller: 1.7, sheet: -0.2, hike: 2 })).toEqual({ tiller: 1, sheet: 0, hike: 1 });
  });

  it('creates a moored boat at the first berth', () => {
    physics.setConfig(trace.config);
    expect(physics.mooredAt(0, 0).moored).toBe(true);
  });
});
