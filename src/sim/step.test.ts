import { describe, expect, it } from 'vitest';
import { buildBoat } from './boat';
import { defaultConfig, withDisabledLayers, type SimConfig } from './config';
import { DEG, KNOT } from './frames';
import { initialState, type BoatState } from './state';
import { step } from './step';
import { getWind } from './wind';

const boat = buildBoat();

function run(cfg: SimConfig, s: BoatState, seconds: number, sheet = 0.3): BoatState {
  const n = Math.round(seconds / cfg.dt);
  for (let i = 0; i < n; i++) s = step(s, { tiller: 0, sheet, hike: 0.3 }, boat, cfg).state;
  return s;
}

describe('sim integration', () => {
  it('settles and then stays still in zero wind (no jitter, no drift)', () => {
    const cfg = { ...defaultConfig(), wind: { speedKn: 0, fromDeg: 0 } };
    // The sailor moves out to the side deck first, which heels and nudges the boat.
    // Hull and foil drag are quadratic, so the residual drift decays slowly (~1/t).
    const settled = run(cfg, initialState(0, 0), 120);
    const later = run(cfg, settled, 30);
    const speed = (s: BoatState) => Math.hypot(s.u, s.v);
    expect(speed(settled)).toBeLessThan(5e-3);
    expect(speed(later)).toBeLessThan(speed(settled));
    // Heeled by the sailor's weight, the hull's zero-lift drift turns the creeping boat very slowly.
    expect(Math.abs(later.r)).toBeLessThan(1e-4);
    expect(Math.abs(later.p)).toBeLessThan(1e-6);
    expect(Math.abs(later.heel - settled.heel)).toBeLessThan(1e-5);
  });

  it('only loses energy when coasting in calm air', () => {
    // Heel off: the sailor shifting weight is an internal energy source, not a leak.
    const cfg = { ...withDisabledLayers(defaultConfig(), ['heel']), wind: { speedKn: 0, fromDeg: 0 } };
    let s = initialState(0, 2);
    let prev = Infinity;
    for (let i = 0; i < 60 * 20; i++) {
      s = step(s, { tiller: 0, sheet: 0, hike: 0 }, boat, cfg).state;
      const ke = s.u * s.u + s.v * s.v;
      expect(ke).toBeLessThanOrEqual(prev + 1e-12);
      prev = ke;
    }
  });

  it('reaches the same steady speed at half the timestep', () => {
    // Heading held (yaw off) on a beam reach so the comparison is not about steering.
    const base = withDisabledLayers(defaultConfig(), ['yaw']);
    const start = { ...initialState(90 * DEG, 1.5), boomSide: 1 as const, crewY: -0.55 };
    const coarse = run(base, start, 120);
    const fine = run({ ...base, dt: base.dt / 2 }, start, 120);
    expect(coarse.u).toBeGreaterThan(1 * KNOT);
    expect(Math.abs(coarse.u - fine.u) / fine.u).toBeLessThan(0.01);
    expect(Math.abs(coarse.heel - fine.heel)).toBeLessThan(0.2 * DEG);
  });

  it('does not propel itself with the sail off (crew must not rock the boat head to wind)', () => {
    // Regression: the boom flicking across the centreline used to send the sailor from
    // side to side, and the resulting roll pumping drove the boat at ~3 kn forever.
    const cfg = withDisabledLayers(defaultConfig(), ['sail', 'apparentWind']);
    let s = initialState(0, 3 * KNOT);
    for (let i = 0; i < 60 * 60; i++) s = step(s, { tiller: 0, sheet: 0.5, hike: 0 }, boat, cfg).state;
    expect(Math.hypot(s.u, s.v)).toBeLessThan(1 * KNOT);
  });

  it('rejects unknown layer names', () => {
    expect(() => withDisabledLayers(defaultConfig(), ['sails'])).toThrow(/unknown layer/);
  });

  it('getWind blows from the configured compass direction', () => {
    const w = getWind({ x: 0, z: 0 }, 0, { speedKn: 10, fromDeg: 0 });
    expect(w.x).toBeCloseTo(0, 12);
    expect(w.z).toBeCloseTo(10 * KNOT, 12); // from the north toward +z (south)
  });
});
