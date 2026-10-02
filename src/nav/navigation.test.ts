import { describe, expect, it } from 'vitest';
import { DEG, worldToBearing } from '../sim/frames';
import { NAV_BUOYS, NAVIGATION, Navigation, graduatedBearing, positionLine, solveFix, type NavigationState, type Observation } from './navigation';

const state = (x = 0, z = 0): NavigationState => ({ x, z, t: 0, loggedSpeed: 0, trackX: 0, trackZ: 0, distance: 0 });
function note(id: number, buoyId: string, from = { x: 0, z: 0 }): Observation {
  const buoy = NAV_BUOYS.find((b) => b.name === buoyId)!;
  return { id, buoyId, bearing: worldToBearing(buoy.x - from.x, buoy.z - from.z), t: 0, trackX: 0, trackZ: 0 };
}

describe('dead reckoning instruments', () => {
  it('integrates north/east headings and a signed log, without a sideways-velocity or position input', () => {
    const nav = new Navigation(13);
    nav.advance({ t: 1, heading: 0, speed: 2 }, 1);
    expect(nav.state.x).toBe(0);
    expect(nav.state.z).toBeLessThan(-2);
    const z = nav.state.z;
    nav.advance({ t: 2, heading: Math.PI / 2, speed: 2 }, 1);
    expect(nav.state.x).toBeGreaterThan(2);
    expect(nav.state.z).toBeCloseTo(z, 10);
    nav.advance({ t: 3, heading: Math.PI / 2, speed: -2 }, 1);
    expect(Math.abs(nav.state.x)).toBeLessThan(0.01);
    expect(nav.state.loggedSpeed).toBeLessThan(0);
    expect(nav.state.distance).toBeGreaterThan(6);
  });

  it('has repeatable gentle error over minutes, distinct calibration by seed, and no drift at rest', () => {
    const run = (seed: number) => {
      const nav = new Navigation(seed);
      for (let t = 1; t <= 300; t++) nav.advance({ t, heading: Math.PI / 2, speed: 2 }, 1);
      return nav;
    };
    const a = run(7), b = run(7), c = run(8);
    expect(a.state).toEqual(b.state);
    expect(a.state.x).not.toBe(c.state.x);
    expect(a.state.x - 600).toBeGreaterThan(0);
    expect(a.state.x - 600).toBeLessThan(20);
    const position = { x: a.state.x, z: a.state.z };
    a.advance({ t: 301, heading: 1, speed: 0 }, 1);
    expect({ x: a.state.x, z: a.state.z }).toEqual(position);
  });

  it('converges with timestep refinement rather than accumulating frame-random noise', () => {
    const run = (dt: number) => {
      const nav = new Navigation(5);
      for (let i = 1; i <= Math.round(120 / dt); i++) nav.advance({ t: i * dt, heading: 1, speed: 2 }, dt);
      return nav.state;
    };
    const a = run(1 / 60), b = run(1 / 120);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.001);
  });

  it('resets estimate, odometer, notes, and calibration replay to the known departure', () => {
    const nav = new Navigation(3);
    nav.advance({ t: 1, heading: 0, speed: 2 }, 1);
    const moved = { ...nav.state };
    nav.record(0);
    nav.reset();
    expect(nav.state).toEqual(state());
    expect(nav.observations).toEqual([]);
    expect(nav.selected.size).toBe(0);
    nav.advance({ t: 1, heading: 0, speed: 2 }, 1);
    expect(nav.state).toEqual(moved);
  });

  it('ignores invalid readings without poisoning the estimate', () => {
    const nav = new Navigation();
    nav.advance({ t: 1, heading: NaN, speed: 2 }, 1);
    nav.advance({ t: 1, heading: 0, speed: 2 }, -1);
    expect(nav.state).toEqual(state());
  });
});

describe('bearing lines and fixes', () => {
  it('graduates and wraps bearings on both sides of north', () => {
    expect(graduatedBearing(359.9 * DEG)).toBeCloseTo(0, 10);
    expect(graduatedBearing(-0.6 * DEG) / DEG).toBeCloseTo(359.5, 10);
    expect(graduatedBearing(720.6 * DEG) / DEG).toBeCloseTo(0.5, 10);
  });

  it('projects a one-bearing estimate onto the line without inventing an along-line fix', () => {
    const result = solveFix([note(1, 'N')], state(40, 25));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position.x).toBeCloseTo(0, 10);
      expect(result.position.z).toBe(25);
    }
  });

  it('recovers an independent point from two identified bearings', () => {
    const from = { x: 35, z: 45 };
    const result = solveFix([note(1, 'N', from), note(2, 'E', from)], state(60, 80));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position.x).toBeCloseTo(from.x, 10);
      expect(result.position.z).toBeCloseTo(from.z, 10);
    }
  });

  it('advances earlier lines by logged motion between sightings and during plotting', () => {
    const first = note(1, 'N');
    const second = { ...note(2, 'E', { x: 40, z: 20 }), t: 20, trackX: 40, trackZ: 20 };
    const current = { ...state(80, 10), t: 35, trackX: 70, trackZ: 30 };
    const result = solveFix([first, second], current);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position.x).toBeCloseTo(70, 10);
      expect(result.position.z).toBeCloseTo(30, 10);
    }
    expect(positionLine(first, current)?.buoy).toEqual({ x: 70, z: -120 });
  });

  it('rejects parallel/antiparallel geometry, unidentified/expired notes, and wrong-way rays', () => {
    const a = note(1, 'N');
    const parallel = { ...note(2, 'E'), bearing: a.bearing + 5 * DEG };
    const opposite = { ...parallel, bearing: a.bearing + Math.PI };
    expect(solveFix([a, parallel], state())).toMatchObject({ ok: false, reason: expect.stringMatching(/parallel/) });
    expect(solveFix([a, opposite], state()).ok).toBe(false);
    expect(solveFix([{ ...a, buoyId: null }], state()).ok).toBe(false);
    expect(solveFix([a], { ...state(), t: NAVIGATION.maxBearingAge + 1 }).ok).toBe(false);
    expect(solveFix([{ ...a, bearing: Math.PI }], state())).toMatchObject({ ok: false, reason: expect.stringMatching(/away/) });
    expect(solveFix([], state()).ok).toBe(false);
  });

  it('requires explicit identification and correction, preserves log references, and bounds notes', () => {
    const nav = new Navigation();
    nav.state = { ...state(50, 20), t: 10, trackX: 25, trackZ: 5 };
    nav.record(0);
    expect(nav.applyFix().ok).toBe(false);
    nav.identify(1, 'N');
    expect(nav.state.x).toBe(50);
    expect(nav.applyFix().ok).toBe(true);
    expect(nav.state.x).toBeCloseTo(0);
    expect(nav.state.trackX).toBe(25);
    expect(nav.state.trackZ).toBe(5);
    for (let i = 0; i < NAVIGATION.maxObservations + 3; i++) nav.record(i);
    expect(nav.observations).toHaveLength(NAVIGATION.maxObservations);
    expect(nav.selected.size).toBe(2);
    expect([...nav.selected].every((id) => nav.observations.some((o) => o.id === id))).toBe(true);
    const before = { ...nav.state };
    nav.clearNotes();
    expect(nav.state).toEqual(before);
  });
});
