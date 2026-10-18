import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Physics } from '../physics/bridge';
import { loadPhysics } from '../physics/load';
import type { BoatState, Controls, SimConfig } from '../physics/types';
import { DEG, wrapPi } from '../sim/frames';
import type { NetClient } from './client';
import { OFFSET_TAU, ZERO_OFFSET } from './correction';
import { ServerLink } from './link';
import type { ShownPose } from './link';
import type { SnapshotMessage, WelcomeMessage } from './protocol';

const APPLIED: Controls = { tiller: 0.2, sheet: 0.6, hike: 0.3 };

class StubClient {
  nextSeq = 1;
  rewelcome: WelcomeMessage | null = null;
  snapshot: SnapshotMessage | null = null;
  latest: SnapshotMessage | null = null;
  readonly sent: { seq: number; controls: Controls; castOff: boolean }[] = [];
  resets = 0;
  readonly url = 'ws://test/ws';
  readonly status = 'connected';
  readonly closeReason = '';
  readonly id = 1;
  readonly remote = new Map();
  readonly totalAttempts = 0;
  readonly rttMs = 20;
  readonly meanRttMs = 25;

  takeRewelcome(): WelcomeMessage | null {
    const welcome = this.rewelcome;
    this.rewelcome = null;
    return welcome;
  }

  takeSnapshot(): SnapshotMessage | null {
    const snapshot = this.snapshot;
    this.snapshot = null;
    return snapshot;
  }

  sendInput(controls: Controls, castOff: boolean): number {
    const seq = this.nextSeq++;
    this.sent.push({ seq, controls, castOff });
    return seq;
  }

  sendReset(): void {
    this.resets++;
  }

  receive(ackSeq: number, state: BoatState): void {
    this.latest = this.snapshot = { type: 'snapshot', tick: ackSeq, ackSeq, state, controls: APPLIED, boats: [] };
  }
}

interface Harness {
  client: StubClient;
  link: ServerLink;
  cfg: SimConfig;
  initial: BoatState;
}

function welcome(state: BoatState, cfg: SimConfig, resumed = false): WelcomeMessage {
  return {
    type: 'welcome', id: 1, resume: 'resume', resumed, seed: 123,
    config: cfg, dt: cfg.dt, tick: 0, state, snapshotHz: 20,
  };
}

function shown(state: BoatState, dx = 0, dz = 0, dHeading = 0): ShownPose {
  return { x: state.x + dx, z: state.z + dz, heading: state.heading + dHeading };
}

describe('ServerLink rewind/replay lifecycle and render correction', () => {
  let physics: Physics;
  let h: Harness;

  beforeAll(async () => {
    physics = await loadPhysics(await readFile(new URL('../../public/wasm/sim.wasm', import.meta.url)));
  });

  beforeEach(() => {
    const cfg = physics.setConfig(physics.browserConfig(123));
    const initial = physics.castOff(physics.mooredAt(0, 0));
    const client = new StubClient();
    h = { client, cfg, initial, link: new ServerLink(client as unknown as NetClient, welcome(initial, cfg), cfg, physics) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores pre-reset acknowledgements and respawns on the first ack at or above the reset sequence', () => {
    const { client, link, initial } = h;
    const first = physics.step(initial, APPLIED);
    link.afterStep(first, APPLIED, false);
    link.reset();
    expect(client.resets).toBe(1);
    const second = physics.step(first, APPLIED);
    link.afterStep(second, APPLIED, false);
    link.offset = { dx: 0.5, dz: -0.2, dHeading: 0.1 };
    const offset = link.offset;
    client.receive(1, { ...first, x: first.x + 1 });
    expect(link.sync(first, second, shown(second), 0.4)).toEqual({ kind: 'steady' });
    expect(link.offset).toBe(offset);
    const spawn = physics.mooredAt(0, second.t);
    client.receive(2, spawn);
    expect(link.sync(first, second, shown(second), 0.4)).toEqual({ kind: 'respawned' });
    expect(link.spawn).toEqual(spawn);
    expect(link.spawn).not.toBe(spawn);
    expect(link.offset).toEqual(ZERO_OFFSET);
    client.receive(2, first);
    expect(link.sync(spawn, spawn, shown(spawn), 0)).toEqual({ kind: 'steady' });
    expect(link.counts).toEqual({ replay: 0, resync: 0, snap: 0 });
  });

  it('adopts a fresh rewelcome config and spawn, clearing the offset and any pending reset', () => {
    const { client, link, cfg, initial } = h;
    link.reset();
    link.offset = { dx: 1, dz: 0, dHeading: 0.1 };
    const freshConfig = physics.browserConfig(456);
    freshConfig.wind.speedKn = 9;
    const fresh = welcome(physics.mooredAt(0, 5), freshConfig);
    fresh.seed = 456;
    fresh.dt = 1 / 30;
    const setConfig = vi.spyOn(physics, 'setConfig');
    client.rewelcome = fresh;
    expect(link.sync(initial, initial, shown(initial), 0.5)).toEqual({ kind: 'respawned' });
    expect(link.welcome).toBe(fresh);
    expect(link.spawn).toEqual(fresh.state);
    expect(link.spawn).not.toBe(fresh.state);
    expect(link.offset).toEqual(ZERO_OFFSET);
    expect(setConfig).toHaveBeenCalledWith({ ...freshConfig, dt: fresh.dt });
    expect(link.cfg).toBe(cfg);
    expect(cfg.dt).toBe(fresh.dt);
    expect(cfg.wind.speedKn).toBe(9);
    const next = physics.step(fresh.state, APPLIED);
    link.afterStep(next, APPLIED, false);
    client.receive(1, { ...next, x: next.x + 0.2 });
    expect(link.sync(fresh.state, next, shown(next), 0.5).kind).toBe('moved');
  });

  it('adopts a resumed welcome with a fresh ring and consumes an already waiting old snapshot', () => {
    const { client, link, cfg, initial } = h;
    const oldPrediction = physics.step(initial, APPLIED);
    link.afterStep(oldPrediction, APPLIED, false);
    link.reset();
    const resumedState = { ...oldPrediction, x: oldPrediction.x + 0.3 };
    const resumed = welcome(resumedState, cfg, true);
    client.rewelcome = resumed;
    client.receive(1, { ...oldPrediction, x: oldPrediction.x + 1 });
    const setConfig = vi.spyOn(physics, 'setConfig');
    expect(link.sync(initial, oldPrediction, shown(resumedState, 0.5), 0.6)).toEqual({ kind: 'moved', prev: resumedState, curr: resumedState });
    expect(client.snapshot).toBeNull();
    expect(link.welcome).toBe(resumed);
    expect(link.offset.dx).toBeCloseTo(0.5, 12);
    expect(link.last).toEqual({ kind: 'resync', snap: false, position: 0.5, heading: 0 });
    expect(link.counts).toEqual({ replay: 0, resync: 1, snap: 0 });
    expect(setConfig).not.toHaveBeenCalled();
    const next = physics.step(resumedState, APPLIED);
    link.afterStep(next, APPLIED, false);
    client.receive(2, { ...next, x: next.x + 0.1 });
    expect(link.sync(resumedState, next, shown(next), 0.6).kind).toBe('moved');
    expect(link.last?.kind).toBe('replay');
    expect(link.counts).toEqual({ replay: 1, resync: 1, snap: 0 });
  });

  it('returns a resumed timeline even when no snapshot has arrived', () => {
    const { client, link, cfg, initial } = h;
    const state = { ...initial, z: initial.z + 0.4 };
    client.rewelcome = welcome(state, cfg, true);
    expect(link.sync(initial, initial, null, 0.9)).toEqual({ kind: 'moved', prev: state, curr: state });
    expect(link.offset).toEqual(ZERO_OFFSET);
    expect(link.last).toEqual({ kind: 'resync', snap: false, position: 0, heading: 0 });
  });

  it('computes the offset from the replayed candidate at the supplied alpha without changing any state', () => {
    const { client, link, initial } = h;
    const first = physics.step(initial, APPLIED);
    const second = physics.step(first, APPLIED);
    link.afterStep(first, APPLIED, false);
    link.afterStep(second, APPLIED, false);
    const authoritative = Object.freeze({ ...first, x: first.x + 0.2, z: first.z - 0.3 });
    const expected = physics.step(authoritative, APPLIED);
    const alpha = 0.23;
    const candidate = {
      x: authoritative.x + (expected.x - authoritative.x) * alpha,
      z: authoritative.z + (expected.z - authoritative.z) * alpha,
      heading: authoritative.heading + wrapPi(expected.heading - authoritative.heading) * alpha,
    };
    const lastShown = Object.freeze({ x: candidate.x + 0.5, z: candidate.z - 0.2, heading: candidate.heading + 0.1 });
    const before = { first: { ...first }, second: { ...second }, authoritative: { ...authoritative }, shown: { ...lastShown } };
    Object.freeze(first);
    Object.freeze(second);
    client.receive(1, authoritative);
    const result = link.sync(first, second, lastShown, alpha);
    expect(result).toEqual({ kind: 'moved', prev: authoritative, curr: expected });
    expect(link.offset.dx).toBeCloseTo(0.5, 12);
    expect(link.offset.dz).toBeCloseTo(-0.2, 12);
    expect(link.offset.dHeading).toBeCloseTo(0.1, 12);
    expect({ first, second, authoritative, shown: lastShown }).toEqual(before);
    expect(link.last?.kind).toBe('replay');
  });

  it('replaces the old remaining offset using the pose actually shown', () => {
    const { client, link, cfg, initial } = h;
    client.rewelcome = welcome(initial, cfg, true);
    link.sync(initial, initial, shown(initial, 0.5), 0.5);
    link.decay(OFFSET_TAU);
    const remainder = link.offset.dx;
    const corrected = { ...initial, x: initial.x + 0.1 };
    client.rewelcome = welcome(corrected, cfg, true);
    link.sync(initial, initial, shown(initial, remainder), 0.5);
    expect(link.offset.dx).toBeCloseTo(remainder - 0.1, 12);
    expect(link.counts).toEqual({ replay: 0, resync: 2, snap: 0 });
  });

  it('snaps a large position error while retaining its pre-snap magnitude in diagnostics', () => {
    const { client, link, cfg, initial } = h;
    client.rewelcome = welcome(initial, cfg, true);
    link.sync(initial, initial, shown(initial, 3), 0.5);
    expect(link.offset).toEqual(ZERO_OFFSET);
    expect(link.last).toEqual({ kind: 'resync', snap: true, position: 3, heading: 0 });
    expect(link.counts).toEqual({ replay: 0, resync: 1, snap: 1 });
    expect(link.describe()).toContain('last correction resync snap 300.0 cm  0.00°');
    expect(link.describe()).toContain('replays 0  resyncs 1  snaps 1');
  });

  it('wraps heading errors across pi and snaps errors above the heading threshold', () => {
    const { client, link, cfg, initial } = h;
    const authoritative = { ...initial, heading: -179 * DEG };
    client.rewelcome = welcome(authoritative, cfg, true);
    link.sync(initial, initial, { ...shown(authoritative), heading: 179 * DEG }, 0.5);
    expect(link.offset.dHeading).toBeCloseTo(-2 * DEG, 12);
    expect(link.last?.snap).toBe(false);
    client.rewelcome = welcome(authoritative, cfg, true);
    link.sync(initial, initial, shown(authoritative, 0, 0, 21 * DEG), 0.5);
    expect(link.offset).toEqual(ZERO_OFFSET);
    expect(link.last?.heading).toBeCloseTo(21 * DEG, 12);
    expect(link.last?.snap).toBe(true);
    expect(link.counts.snap).toBe(1);
  });

  it('decays exponentially and zeros sub-millimetre, sub-milliradian remnants', () => {
    const { link } = h;
    link.offset = { dx: 0.5, dz: -0.25, dHeading: 0.1 };
    link.decay(OFFSET_TAU);
    expect(link.offset.dx).toBeCloseTo(0.5 / Math.E, 12);
    expect(link.offset.dz).toBeCloseTo(-0.25 / Math.E, 12);
    expect(link.offset.dHeading).toBeCloseTo(0.1 / Math.E, 12);
    link.decay(2 * OFFSET_TAU);
    expect(link.offset.dx).toBeCloseTo(0.5 * Math.exp(-3), 12);
    link.decay(10);
    expect(link.offset).toEqual(ZERO_OFFSET);
    link.offset = { dx: 0.0009, dz: 0.0009, dHeading: 0.0009 };
    link.decay(0);
    expect(link.offset.dx).not.toBe(0);
    link.decay(OFFSET_TAU);
    expect(link.offset).toEqual(ZERO_OFFSET);
  });

  it('replays precisely the clamped controls sent to the server without mutating predictions', () => {
    const { client, link, initial } = h;
    const first = Object.freeze(physics.step(initial, APPLIED));
    const second = Object.freeze(physics.step(first, { tiller: 1.7, sheet: -0.2, hike: 2 }));
    const applied = Object.freeze(physics.appliedControls());
    link.afterStep(first, APPLIED, false);
    link.afterStep(second, applied, false);
    expect(client.sent[1]!.controls).toEqual({ tiller: 1, sheet: 0, hike: 1 });
    const authoritative = { ...first, x: first.x + 0.2 };
    const expected = physics.step(authoritative, { tiller: 1, sheet: 0, hike: 1 });
    client.receive(1, authoritative);
    expect(link.sync(first, second, shown(second), 0.4)).toEqual({
      kind: 'moved', prev: authoritative, curr: expected,
    });
  });

  it('leaves the timeline, diagnostics and remaining offset untouched for matching and stale snapshots', () => {
    const { client, link, initial } = h;
    const first = physics.step(initial, APPLIED);
    const second = physics.step(first, APPLIED);
    link.afterStep(first, APPLIED, false);
    link.afterStep(second, APPLIED, false);
    link.offset = { dx: 0.5, dz: -0.2, dHeading: 0.1 };
    const offset = link.offset;
    const step = vi.spyOn(physics, 'step');
    const castOff = vi.spyOn(physics, 'castOff');
    const evaluate = vi.spyOn(physics, 'evaluate');
    client.receive(1, { ...first });
    expect(link.sync(first, second, shown(second), 0.4)).toEqual({ kind: 'steady' });
    expect(link.offset).toBe(offset);
    expect(link.offset).toEqual({ dx: 0.5, dz: -0.2, dHeading: 0.1 });
    expect(link.last).toBeNull();
    expect(link.counts).toEqual({ replay: 0, resync: 0, snap: 0 });
    client.receive(1, { ...first, x: first.x + 1 });
    expect(link.sync(first, second, shown(second), 0.4)).toEqual({ kind: 'steady' });
    expect(link.offset).toBe(offset);
    expect(step).not.toHaveBeenCalled();
    expect(castOff).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('reports missing-history adoption as a resync and ordinary mismatches as replays', () => {
    const { client, link, initial } = h;
    client.nextSeq = 3;
    client.receive(1, initial);
    expect(link.sync(initial, initial, shown(initial, 0.4), 0.5)).toEqual({ kind: 'moved', prev: initial, curr: initial });
    expect(link.last?.kind).toBe('resync');
    const next = physics.step(initial, APPLIED);
    link.afterStep(next, APPLIED, false);
    const authoritative = { ...next, x: next.x + 0.1 };
    client.receive(3, authoritative);
    expect(link.sync(initial, next, shown(authoritative, 0.5), 0.5)).toEqual({ kind: 'moved', prev: authoritative, curr: authoritative });
    expect(link.counts).toEqual({ replay: 1, resync: 1, snap: 0 });
    expect(link.describe()).toContain('last correction replay 50.0 cm');
    expect(link.describe()).toContain('replays 1  resyncs 1  snaps 0');
  });
});
