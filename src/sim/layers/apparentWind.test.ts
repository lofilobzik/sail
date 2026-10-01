import { describe, expect, it } from 'vitest';
import { DEG } from '../frames';
import { initialState } from '../state';
import { getWind } from '../wind';
import { apparentWind } from './apparentWind';

const windFrom = (fromDeg: number, speedKn: number) => getWind({ x: 0, z: 0 }, 0, { fromDeg, speedKn });

describe('L1 apparent wind', () => {
  it('equals the true wind for a boat at rest, angle measured from the bow (+ = starboard)', () => {
    const state = initialState(0, 0); // heading north
    const aw = apparentWind(state, windFrom(90, 10), true); // wind from the east = starboard beam
    expect(aw.angle / DEG).toBeCloseTo(90, 9);
    expect(aw.speed).toBeCloseTo(10 * 0.514444, 4);
    expect(apparentWind(state, windFrom(270, 10), true).angle / DEG).toBeCloseTo(-90, 9);
  });

  it('adds boat speed head to wind', () => {
    const trueWind = windFrom(0, 0);
    const state = initialState(0, 2); // heading into a calm at 2 m/s
    const aw = apparentWind(state, { x: trueWind.x, z: trueWind.z + 3 }, true); // 3 m/s from the north
    expect(aw.speed).toBeCloseTo(5, 9);
    expect(aw.angle).toBeCloseTo(0, 9);
  });

  it('moves the apparent wind forward and strengthens it on a beam reach', () => {
    const state = initialState(90 * DEG, 2); // heading east, wind from the north (port beam)
    const aw = apparentWind(state, windFrom(0, 7), true);
    expect(aw.angle).toBeLessThan(0);
    expect(Math.abs(aw.angle)).toBeLessThan(90 * DEG);
    expect(aw.speed).toBeGreaterThan(7 * 0.514444);
  });

  it('ignores boat velocity when the layer is disabled', () => {
    const state = initialState(90 * DEG, 2);
    const aw = apparentWind(state, windFrom(0, 7), false);
    expect(aw.angle / DEG).toBeCloseTo(-90, 9);
    expect(aw.speed).toBeCloseTo(7 * 0.514444, 4);
  });
});
