import { describe, expect, it } from 'vitest';
import { KNOT } from './frames';
import type { WindConfig } from './config';
import { WIND_PARAMETERS, getWind, meanWind, windShiftDeg, windSpeedFactor } from './wind';

const speed = (w: { x: number; z: number }): number => Math.hypot(w.x, w.z);
const gusty = (over: Partial<NonNullable<WindConfig['gusts']>> = {}, wind: Partial<WindConfig> = {}): WindConfig => ({
  speedKn: 7,
  fromDeg: 0,
  gusts: { enabled: true, seed: 1987, gustScale: 1, shiftScale: 1, ...over },
  ...wind,
});

describe('wind', () => {
  it('is exactly the constant mean wind when gusts are absent or disabled', () => {
    const mean = meanWind({ speedKn: 7, fromDeg: 30 });
    expect(getWind({ x: 5, z: -9 }, 123, { speedKn: 7, fromDeg: 30 })).toEqual(mean);
    const off = gusty({ enabled: false }, { fromDeg: 30 });
    expect(getWind({ x: 5, z: -9 }, 123, off)).toEqual(mean);
    expect(windSpeedFactor({ x: 5, z: -9 }, 123, off)).toBe(1);
    expect(windShiftDeg(123, off)).toBe(0);
  });

  it('is a deterministic function of seed, position and time', () => {
    const a = getWind({ x: 12, z: 40 }, 55, gusty());
    expect(getWind({ x: 12, z: 40 }, 55, gusty())).toEqual(a);
    expect(getWind({ x: 12, z: 40 }, 55, gusty({ seed: 7 }))).not.toEqual(a);
  });

  it('carries the gust pattern downwind with the mean wind', () => {
    // Wind from the north blows toward +z at the mean speed: the speed factor seen at p now is seen
    // at p + w*dt a time dt later.
    const cfg = gusty({}, { fromDeg: 0 });
    const w = meanWind(cfg);
    for (const [x, z, t, dt] of [[10, 20, 5, 30], [-300, 80, 1000, 90], [0, 0, 0, 12.5]] as const) {
      const before = windSpeedFactor({ x, z }, t, cfg);
      const after = windSpeedFactor({ x: x + w.x * dt, z: z + w.z * dt }, t + dt, cfg);
      expect(after).toBeCloseTo(before, 9);
    }
  });

  it('has gusts and lulls around a mean near the set speed, within sane bounds', () => {
    const cfg = gusty();
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const f = windSpeedFactor({ x: (i * 37.7) % 2000, z: (i * 91.3) % 2000 }, i * 3.1, cfg);
      sum += f;
      min = Math.min(min, f);
      max = Math.max(max, f);
    }
    expect(sum / n).toBeGreaterThan(0.93);
    expect(sum / n).toBeLessThan(1.07);
    expect(max).toBeGreaterThan(1.25); // real gusts
    expect(min).toBeLessThan(0.8); // real lulls
    expect(min).toBeGreaterThanOrEqual(WIND_PARAMETERS.minFactor);
    expect(max).toBeLessThan(1 + WIND_PARAMETERS.gustAmplitude + 1e-9);
  });

  it('scales gust strength and removes gusts at zero', () => {
    const p = { x: 33, z: -71 };
    const base = windSpeedFactor(p, 20, gusty({ gustScale: 1 })) - 1;
    expect(Math.abs(base)).toBeGreaterThan(0.02);
    expect(windSpeedFactor(p, 20, gusty({ gustScale: 0 }))).toBe(1);
    expect(windSpeedFactor(p, 20, gusty({ gustScale: 0.5 })) - 1).toBeCloseTo(base / 2, 12);
  });

  it('shifts the direction slowly and boundedly, independent of position, and not at zero strength', () => {
    const cfg = gusty({ gustScale: 0 });
    const bound = WIND_PARAMETERS.shifts.reduce((s, c) => s + c.amplitudeDeg, 0);
    let swing = 0;
    for (let t = 0; t <= 1200; t += 5) {
      const shift = windShiftDeg(t, cfg);
      expect(Math.abs(shift)).toBeLessThanOrEqual(bound + 1e-9);
      swing = Math.max(swing, Math.abs(shift));
      expect(windShiftDeg(t + 0.1, cfg) - shift).toBeLessThan(0.1); // slow: well under 1 deg/s
    }
    expect(swing).toBeGreaterThan(3);
    expect(getWind({ x: 0, z: 0 }, 400, cfg)).toEqual(getWind({ x: 5000, z: -3000 }, 400, cfg));
    expect(windShiftDeg(400, gusty({ shiftScale: 0 }))).toBeCloseTo(0, 12);
  });

  it('turns the wind direction as the shift says (clockwise-positive FROM bearing)', () => {
    const cfg = gusty({ gustScale: 0 }, { fromDeg: 90 });
    const t = 40;
    const w = getWind({ x: 0, z: 0 }, t, cfg);
    const fromDeg = (((Math.atan2(-w.x, w.z) * 180) / Math.PI) + 360) % 360; // bearing the wind comes FROM
    expect(fromDeg).toBeCloseTo(90 + windShiftDeg(t, cfg), 9);
    expect(speed(w)).toBeCloseTo(7 * KNOT, 12);
  });

  it('keeps a zero-speed wind calm', () => {
    expect(speed(getWind({ x: 1, z: 2 }, 3, gusty({}, { speedKn: 0 })))).toBe(0);
  });
});
