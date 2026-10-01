import { describe, expect, it } from 'vitest';
import { buildBoat } from '../boat';
import { defaultConfig } from '../config';
import { DEG } from '../frames';
import { initialState, type BoatState } from '../state';
import { step } from '../step';
import { munkMoment } from './yaw';

const boat = buildBoat();
const cfg = defaultConfig();

describe('L6 yaw', () => {
  it('Munk moment follows Day 2017 Eq. 14 and is destabilizing', () => {
    const state = { ...initialState(0, 2), v: 0.1, heel: 10 * DEG };
    const n0 = 0.0002164 * boat.mass - 0.014572;
    const expected = -(Math.PI / 2) * cfg.env.rhoWater * n0 * (1 + 0.0966 + 0.134) * 2 * 0.1;
    expect(munkMoment(state, boat, cfg.env)).toBeCloseTo(expected, 9);
    // Sliding to starboard: the moment turns the bow to port, increasing the drift angle.
    expect(munkMoment(state, boat, cfg.env)).toBeLessThan(0);
  });

  it('turns the boat with the tiller and holds the heading when the layer is off', () => {
    const calm = { ...cfg, wind: { speedKn: 0, fromDeg: 0 } };
    let s = initialState(0, 2);
    for (let i = 0; i < 120; i++) s = step(s, { tiller: 1, sheet: 0, hike: 0 }, boat, calm).state;
    expect(s.heading).toBeLessThan(-5 * DEG); // tiller to starboard -> turns to port

    const off = { ...calm, layers: { ...calm.layers, yaw: false } };
    let f = initialState(0, 2);
    for (let i = 0; i < 120; i++) f = step(f, { tiller: 1, sheet: 0, hike: 0 }, boat, off).state;
    expect(f.heading).toBe(0);
    expect(f.r).toBe(0);
  });

  it('rounds up into the wind with the tiller centred on a reach (weather helm)', () => {
    // Wind from the north, boat heading east (port beam), sheet trimmed, tiller free.
    let s: BoatState = { ...initialState(90 * DEG, 2), boomSide: 1, boom: 40 * DEG, crewY: -0.55 };
    for (let i = 0; i < 60 * 10; i++) s = step(s, { tiller: 0, sheet: 0.4, hike: 0.3 }, boat, cfg).state;
    expect(s.heading).toBeLessThan(80 * DEG); // turned toward the wind (north)
  });
});
