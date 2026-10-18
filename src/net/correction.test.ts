import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Physics } from '../physics/bridge';
import { loadPhysics } from '../physics/load';
import type { BoatState, Controls, SimConfig } from '../physics/types';
import { initialState, NEUTRAL_CONTROLS } from '../sim/state';
import { Reconciler } from './correction';
import type { SnapshotMessage } from './protocol';

const NUMERIC_FIELDS = ['t', 'x', 'z', 'heading', 'u', 'v', 'r', 'heel', 'p', 'pitch', 'pitchRate', 'boom', 'crewY'] as const;
const APPLIED: Controls = { tiller: 0.3, sheet: 0.7, hike: 0.4 };

function snapshot(ackSeq: number, state: BoatState): SnapshotMessage {
  return { type: 'snapshot', tick: ackSeq, ackSeq, state: { ...state }, controls: { ...NEUTRAL_CONTROLS }, boats: [] };
}

describe('Reconciler with Go physics', () => {
  let physics: Physics;
  let config: SimConfig;

  beforeAll(async () => {
    physics = await loadPhysics(await readFile(new URL('../../public/wasm/sim.wasm', import.meta.url)));
    config = physics.browserConfig(1);
  });
  beforeEach(() => {
    physics.setConfig(config);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acknowledges matching predictions without changing the live timeline or calling physics', () => {
    const reconciler = new Reconciler(physics);
    const prev = physics.step(physics.mooredAt(0, 0), APPLIED);
    const curr = physics.step(physics.castOff(prev), APPLIED);
    reconciler.record(1, APPLIED, false, prev);
    reconciler.record(2, APPLIED, true, curr);
    const timeline = { prev, curr };
    const before = structuredClone(timeline);
    const diagnostics = physics.diagnostics();
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    const evaluate = vi.spyOn(physics, 'evaluate');
    expect(reconciler.reconcile(snapshot(1, prev), 2)).toBeNull();
    expect(timeline).toEqual(before);
    expect(curr.moored).toBe(false);
    expect(physics.diagnostics()).toEqual(diagnostics);
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();

    // The matching ack advances ordering and its stored prediction is actually pruned.
    const history = reconciler as unknown as { seqs: Int32Array };
    expect(history.seqs).toBeInstanceOf(Int32Array);
    expect(history.seqs[1]).toBe(-1);
    expect(history.seqs[2]).toBe(2);
    expect(reconciler.reconcile(snapshot(1, { ...prev, x: prev.x + 10 }), 2)).toBeNull();
    expect(reconciler.reconcile(snapshot(2, curr), 2)).toBeNull();
    expect(history.seqs[2]).toBe(-1);
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
  });

  it.each(NUMERIC_FIELDS)('compares %s at and just outside the inclusive absolute 1e-9 boundary', (field) => {
    for (const difference of [0, 0.5e-9, 1e-9, -1e-9, 1.000001e-9, -1.000001e-9]) {
      const reconciler = new Reconciler(physics);
      const predicted = { ...initialState(), [field]: 0 };
      reconciler.record(1, APPLIED, false, predicted);
      const authoritative = snapshot(1, { ...predicted, [field]: difference });
      const result = reconciler.reconcile(authoritative, 1);
      if (Math.abs(difference) <= 1e-9) {
        expect(result, `${field}: ${difference}`).toBeNull();
      } else {
        expect(result, `${field}: ${difference}`).toEqual({ prev: authoritative.state, curr: authoritative.state });
        expect(reconciler.kind).toBe('replay');
      }
    }
  });

  it.each([
    [Math.PI, -Math.PI],
    [-Math.PI + 0.1, Math.PI + 0.1],
    [0.4, 0.4 + 2 * Math.PI],
    [Math.PI - 1e-10, -Math.PI + 1e-10],
  ])('matches equivalent wrapped headings %s and %s', (predictedHeading, serverHeading) => {
    const reconciler = new Reconciler(physics);
    const predicted = initialState(predictedHeading);
    reconciler.record(1, APPLIED, false, predicted);
    expect(reconciler.reconcile(snapshot(1, { ...predicted, heading: serverHeading }), 1)).toBeNull();
  });

  it.each(NUMERIC_FIELDS)('never matches non-finite %s on either side', (field) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      for (const side of ['prediction', 'snapshot', 'both']) {
        const reconciler = new Reconciler(physics);
        const predicted = { ...initialState(), [field]: side !== 'snapshot' ? value : 0 };
        const authoritative = { ...initialState(), [field]: side !== 'prediction' ? value : 0 };
        reconciler.record(1, APPLIED, false, predicted);
        expect(reconciler.reconcile(snapshot(1, authoritative), 1), `${field}: ${side} ${value}`).not.toBeNull();
        expect(reconciler.kind).toBe('replay');
      }
    }
  });

  it('does not mistake an overflowing heading difference for a match', () => {
    const reconciler = new Reconciler(physics);
    const predicted = initialState(-Number.MAX_VALUE);
    reconciler.record(1, APPLIED, false, predicted);
    expect(reconciler.reconcile(snapshot(1, initialState(Number.MAX_VALUE)), 1)).not.toBeNull();
  });

  it('never matches a non-finite discrete numeric field', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const reconciler = new Reconciler(physics);
      const state: BoatState = { ...initialState(), boomSide: value as BoatState['boomSide'] };
      reconciler.record(1, APPLIED, false, state);
      expect(reconciler.reconcile(snapshot(1, state), 1)).not.toBeNull();
    }
  });

  it('requires exact discrete state equality', () => {
    for (const changed of [{ boomSide: -1 as const }, { moored: true }]) {
      const reconciler = new Reconciler(physics);
      const predicted = initialState();
      reconciler.record(1, APPLIED, false, predicted);
      const authoritative = snapshot(1, { ...predicted, ...changed });
      expect(reconciler.reconcile(authoritative, 1)).toEqual({ prev: authoritative.state, curr: authoritative.state });
    }
  });

  it('replays a mismatch through the recorded cast-off in order using real Go physics', () => {
    const reconciler = new Reconciler(physics);
    const one = physics.step(physics.mooredAt(0, 0), APPLIED);
    const two = physics.step(physics.castOff(one), NEUTRAL_CONTROLS);
    const three = physics.step(two, APPLIED);
    reconciler.record(1, APPLIED, false, one);
    reconciler.record(2, NEUTRAL_CONTROLS, true, two);
    reconciler.record(3, APPLIED, false, three);
    const authoritative = snapshot(1, { ...one, x: one.x + 0.4, heel: one.heel + 0.05 });
    const unchanged = structuredClone({ authoritative, one, two, three });
    const unmoored = physics.castOff(authoritative.state);
    const expectedPrev = physics.step(unmoored, NEUTRAL_CONTROLS);
    const expectedCurr = physics.step(expectedPrev, APPLIED);
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    const result = reconciler.reconcile(authoritative, 3);
    expect(result).toEqual({ prev: expectedPrev, curr: expectedCurr });
    expect(result?.curr.moored).toBe(false);
    expect(reconciler.kind).toBe('replay');
    expect(castOff).toHaveBeenCalledExactlyOnceWith(authoritative.state);
    expect(step).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenNthCalledWith(1, unmoored, NEUTRAL_CONTROLS);
    expect(step).toHaveBeenNthCalledWith(2, expectedPrev, APPLIED);
    expect(castOff.mock.invocationCallOrder[0]).toBeLessThan(step.mock.invocationCallOrder[0]!);
    expect({ authoritative, one, two, three }).toEqual(unchanged);

    // Both replayed predictions must replace their stale pre-correction values.
    step.mockClear();
    castOff.mockClear();
    expect(reconciler.reconcile(snapshot(2, expectedPrev), 3)).toBeNull();
    expect(reconciler.reconcile(snapshot(3, expectedCurr), 3)).toBeNull();
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
  });

  it('keeps prev before a final-step cast-off, without mutating the snapshot', () => {
    const reconciler = new Reconciler(physics);
    const authoritative = snapshot(1, physics.mooredAt(0, 0));
    const before = { ...authoritative.state };
    const expected = physics.step(physics.castOff(before), APPLIED);
    reconciler.record(2, APPLIED, true, expected);
    const result = reconciler.reconcile(authoritative, 2);
    expect(result?.prev).toBe(authoritative.state);
    expect(result?.prev.moored).toBe(true);
    expect(result?.curr).toEqual(expected);
    expect(result?.curr.moored).toBe(false);
    expect(authoritative.state).toEqual(before);
  });

  it('resyncs on a gap even for a matching ack, then preserves future recorded inputs', () => {
    const reconciler = new Reconciler(physics);
    const one = physics.step(physics.mooredAt(0, 0), APPLIED);
    reconciler.record(1, APPLIED, false, one);
    // Seq 2 is missing. Seq 5 is already recorded beyond this call\'s latestSeq (3).
    reconciler.record(3, APPLIED, false, one);
    reconciler.record(5, APPLIED, true, one);
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    const authoritative = snapshot(1, one);
    expect(reconciler.reconcile(authoritative, 3)).toEqual({ prev: authoritative.state, curr: authoritative.state });
    expect(reconciler.kind).toBe('resync');
    expect(reconciler.reconcile(snapshot(2, { ...one, x: 100 }), 3)).toBeNull();
    expect(reconciler.reconcile(snapshot(3, { ...one, x: 100 }), 3)).toBeNull();
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();

    const four = snapshot(4, { ...one, x: one.x + 0.2 });
    const expectedPrev = physics.step(physics.castOff(four.state), APPLIED);
    const expectedCurr = physics.step(expectedPrev, NEUTRAL_CONTROLS);
    reconciler.record(6, NEUTRAL_CONTROLS, false, one);
    step.mockClear();
    castOff.mockClear();
    expect(reconciler.reconcile(four, 6)).toEqual({ prev: expectedPrev, curr: expectedCurr });
    expect(reconciler.kind).toBe('replay');
    expect(step).toHaveBeenCalledTimes(2);
    expect(castOff).toHaveBeenCalledExactlyOnceWith(four.state);
  });

  it('copies upstream-clamped controls without clamping again during record or replay', () => {
    const reconciler = new Reconciler(physics);
    const controls = physics.clampControls({ tiller: 1.7, sheet: -0.2, hike: 2 });
    expect(controls).toEqual({ tiller: 1, sheet: 0, hike: 1 });
    const authoritative = snapshot(1, physics.mooredAt(0, 0));
    const expected = physics.step(authoritative.state, controls);
    const clamp = vi.spyOn(physics, 'clampControls');
    reconciler.record(2, controls, false, expected);
    Object.assign(controls, { tiller: -1, sheet: 1, hike: 0 });
    const step = vi.spyOn(physics, 'step');
    expect(reconciler.reconcile(authoritative, 2)?.curr).toEqual(expected);
    expect(step).toHaveBeenCalledExactlyOnceWith(authoritative.state, { tiller: 1, sheet: 0, hike: 1 });
    expect(clamp).not.toHaveBeenCalled();
  });

  it('copies recorded predictions and refreshed replay predictions away from mutable states', () => {
    const reconciler = new Reconciler(physics);
    const mutable = physics.step(physics.mooredAt(0, 0), APPLIED);
    const original = { ...mutable };
    reconciler.record(1, APPLIED, false, mutable);
    for (const field of NUMERIC_FIELDS) mutable[field] += 10;
    mutable.boomSide = mutable.boomSide === 1 ? -1 : 1;
    mutable.moored = !mutable.moored;
    expect(reconciler.reconcile(snapshot(1, original), 1)).toBeNull();

    reconciler.record(3, APPLIED, false, original);
    const result = reconciler.reconcile(snapshot(2, original), 3)!;
    const corrected = { ...result.curr };
    for (const field of NUMERIC_FIELDS) result.curr[field] += 10;
    result.curr.boomSide = result.curr.boomSide === 1 ? -1 : 1;
    result.curr.moored = !result.curr.moored;
    const step = vi.spyOn(physics, 'step');
    expect(reconciler.reconcile(snapshot(3, corrected), 3)).toBeNull();
    expect(step).not.toHaveBeenCalled();
  });

  it('replays only inputs after an ack that skips dropped queue entries', () => {
    const reconciler = new Reconciler(physics);
    const one = physics.step(physics.mooredAt(0, 0), APPLIED);
    let predicted = one;
    for (let seq = 1; seq <= 5; seq++) {
      if (seq > 1) predicted = physics.step(seq === 2 ? physics.castOff(predicted) : predicted, APPLIED);
      reconciler.record(seq, APPLIED, seq === 2, predicted);
    }
    // Server dropped input 2 (including its cast-off), applying input 3 directly after 1.
    const authoritative = snapshot(3, physics.step(one, APPLIED));
    const expectedPrev = physics.step(authoritative.state, APPLIED);
    const expectedCurr = physics.step(expectedPrev, APPLIED);
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    expect(reconciler.reconcile(authoritative, 5)).toEqual({ prev: expectedPrev, curr: expectedCurr });
    expect(expectedCurr.moored).toBe(true);
    expect(step).toHaveBeenCalledTimes(2);
    expect(castOff).not.toHaveBeenCalled();
  });

  it('ignores duplicate and reordered acks after replay as well as after a match', () => {
    const reconciler = new Reconciler(physics);
    const authoritative = snapshot(3, physics.mooredAt(0, 0));
    expect(reconciler.reconcile(authoritative, 3)).not.toBeNull();
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    reconciler.record(4, APPLIED, true, authoritative.state);
    for (const ack of [3, 2, 1, 0]) {
      expect(reconciler.reconcile(snapshot(ack, { ...authoritative.state, x: 100 }), 4)).toBeNull();
    }
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
    expect(reconciler.reconcile(snapshot(4, authoritative.state), 4)).toBeNull();
  });

  it('starts with lastAck zero and ignores snapshots before any input', () => {
    const reconciler = new Reconciler(physics);
    expect(reconciler.reconcile(snapshot(0, initialState()), 0)).toBeNull();
  });

  it('reset clears history, installs minAck, and resets lastAck independently', () => {
    const reconciler = new Reconciler(physics);
    const state = physics.mooredAt(0, 0);
    expect(reconciler.reconcile(snapshot(10, state), 10)).not.toBeNull();
    reconciler.record(3, APPLIED, true, state);
    reconciler.reset(2);
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    expect(reconciler.reconcile(snapshot(1, state), 3)).toBeNull();
    // Ack 2 is accepted despite the earlier ack 10; cleared input 3 requires resync.
    expect(reconciler.reconcile(snapshot(2, state), 3)).toEqual({ prev: state, curr: state });
    expect(reconciler.kind).toBe('resync');
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
  });

  it('replays a complete 256-entry wrapped ring even when the ack prediction was overwritten', () => {
    const reconciler = new Reconciler(physics);
    const authoritative = snapshot(1, physics.mooredAt(0, 0));
    for (let seq = 1; seq <= 257; seq++) reconciler.record(seq, APPLIED, false, authoritative.state);
    let expectedPrev = authoritative.state;
    let expectedCurr = authoritative.state;
    for (let seq = 2; seq <= 257; seq++) {
      expectedPrev = expectedCurr;
      expectedCurr = physics.step(expectedCurr, APPLIED);
    }
    const step = vi.spyOn(physics, 'step');
    expect(reconciler.reconcile(authoritative, 257)).toEqual({ prev: expectedPrev, curr: expectedCurr });
    expect(reconciler.kind).toBe('replay');
    expect(step).toHaveBeenCalledTimes(256);
    step.mockClear();
    expect(reconciler.reconcile(snapshot(257, expectedCurr), 257)).toBeNull();
    expect(step).not.toHaveBeenCalled();
  });

  it('resyncs rather than replaying an overflowed 257-input window', () => {
    const reconciler = new Reconciler(physics);
    const authoritative = snapshot(1, physics.mooredAt(0, 0));
    for (let seq = 1; seq <= 258; seq++) reconciler.record(seq, APPLIED, seq === 2, authoritative.state);
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    expect(reconciler.reconcile(authoritative, 258)).toEqual({ prev: authoritative.state, curr: authoritative.state });
    expect(reconciler.kind).toBe('resync');
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
  });
});
