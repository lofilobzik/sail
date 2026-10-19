import { describe, expect, it } from 'vitest';
import { KNOT } from './frames';
import type { WindConfig } from '../physics/types';
import {
  WIND_PARAMETERS, activePuffs, getWind, gustDrift, meanWind, puffEnvelope, steadyWeight, windShiftDeg, windSpeedFactor,
} from './wind';

const speed = (w: { x: number; z: number }): number => Math.hypot(w.x, w.z);
const gusty = (over: Partial<NonNullable<WindConfig['gusts']>> = {}, wind: Partial<WindConfig> = {}): WindConfig => ({
  speedKn: 7,
  fromDeg: 0,
  gusts: { enabled: true, seed: 1987, gustScale: 1, shiftScale: 1, ...over },
  ...wind,
});

/** The i-th of the open-water samples (far outside the steady zone). */
const openWaterSample = (i: number): [{ x: number; z: number }, number] =>
  [{ x: -200 + ((i * 37.7) % 2000), z: -1800 + ((i * 91.3) % 2000) }, 300 + i * 0.37];
const OPEN_WATER_SAMPLES = 4000;

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

  it('gives a puff a smooth life: fast rise, slow fade', () => {
    const life = 100; // riseFraction 0.2: peak at age 20
    expect(puffEnvelope(0, life)).toBe(0);
    expect(puffEnvelope(10, life)).toBeGreaterThan(0);
    expect(puffEnvelope(10, life)).toBeLessThan(1);
    expect(puffEnvelope(20, life)).toBe(1);
    expect(puffEnvelope(60, life)).toBeGreaterThan(0);
    expect(puffEnvelope(60, life)).toBeLessThan(puffEnvelope(40, life));
    expect(puffEnvelope(100, life)).toBe(0);
    for (let age = 0.5; age <= life; age += 0.5) {
      expect(Math.abs(puffEnvelope(age, life) - puffEnvelope(age - 0.5, life))).toBeLessThan(0.05);
    }
  });

  it('keeps puffs still in the frame drifting with the wind', () => {
    const w = gusty();
    const before = activePuffs(-2000, -2000, 2000, 2000, 500, w, []);
    const after = activePuffs(-2000, -2000, 2000, 2000, 505, w, []);
    let matches = 0;
    for (const a of before) {
      for (const b of after) {
        if (a.qx !== b.qx || a.qz !== b.qz) continue;
        matches++;
        expect([b.along, b.across, b.strength, b.veerDeg]).toEqual([a.along, a.across, a.strength, a.veerDeg]);
      }
    }
    expect(matches).toBeGreaterThanOrEqual(5);
    const drift = gustDrift(w);
    const mean = meanWind(w);
    expect(drift.x).toBeCloseTo(1.2 * mean.x, 12);
    expect(drift.z).toBeCloseTo(1.2 * mean.z, 12);
  });

  it('only strengthens the wind, up to the cap', () => {
    const cfg = gusty();
    let max = -Infinity;
    for (let i = 0; i < OPEN_WATER_SAMPLES; i++) {
      const [p, t] = openWaterSample(i);
      const f = windSpeedFactor(p, t, cfg);
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(1 + WIND_PARAMETERS.puffs.cap + 1e-12);
      max = Math.max(max, f);
    }
    expect(max).toBeGreaterThan(1.25); // real gusts
  });

  it('scales gust strength and removes gusts at zero', () => {
    const t = 300;
    let p: { x: number; z: number } | null = null;
    for (let x = -200; x <= 1800 && !p; x += 25) {
      for (let z = -1800; z <= 200 && !p; z += 25) {
        if (windSpeedFactor({ x, z }, t, gusty()) > 1.02) p = { x, z };
      }
    }
    if (!p) throw new Error('no gust above 2 % on the grid');
    const base = windSpeedFactor(p, t, gusty({ gustScale: 1 })) - 1;
    expect(windSpeedFactor(p, t, gusty({ gustScale: 0 }))).toBe(1);
    expect(windSpeedFactor(p, t, gusty({ gustScale: 0.5 })) - 1).toBeCloseTo(base / 2, 12);
  });

  it('keeps the wind steady in the Westcove basin', () => {
    const points = [{ x: -1811, z: 741.25 }, { x: -1740, z: 760 }, { x: -1713, z: 753 }, { x: -1713, z: 813 }]; // berth 0, departure, H1, H2
    for (const seed of [1, 0x9e3779b9]) {
      const cfg = gusty({ seed });
      const mean = meanWind(cfg);
      for (let t = 0; t <= 600; t += 7.5) {
        for (const p of points) {
          expect(getWind(p, t, cfg)).toEqual(mean);
          expect(windSpeedFactor(p, t, cfg)).toBe(1);
        }
      }
    }
    const zone = WIND_PARAMETERS.steadyZone;
    expect(steadyWeight(zone.x + zone.innerM - 1, zone.z)).toBe(0);
    expect(steadyWeight(zone.x, zone.z + zone.outerM + 1)).toBe(1);
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
    expect(getWind({ x: 0, z: 0 }, 400, cfg)).toEqual(getWind({ x: 2000, z: -1500 }, 400, cfg));
    expect(windShiftDeg(400, gusty({ shiftScale: 0 }))).toBeCloseTo(0, 12);
  });

  it('veers the wind by at most veerDeg in gusts', () => {
    const cfg = gusty();
    for (let i = 0; i < OPEN_WATER_SAMPLES; i++) {
      const [p, t] = openWaterSample(i);
      const w = getWind(p, t, cfg);
      const fromDeg = (Math.atan2(-w.x, w.z) * 180) / Math.PI; // bearing the wind comes FROM
      const veer = ((fromDeg - (cfg.fromDeg + windShiftDeg(t, cfg)) + 540) % 360) - 180;
      expect(Math.abs(veer)).toBeLessThanOrEqual(WIND_PARAMETERS.puffs.veerDeg + 1e-9);
    }
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
