import { describe, expect, it } from 'vitest';
import { buildBoat } from '../boat';
import { defaultConfig } from '../config';
import { DEG, G, KNOT } from '../frames';
import { initialState } from '../state';
import { heelResistanceCoefficient, hullForces, uprightDragArea } from './hull';

const boat = buildBoat();
const cfg = defaultConfig();

describe('L4 hull resistance', () => {
  it('follows the Day Fig. 2 drag area: R = 1/2 rho V^2 * dragArea', () => {
    const t = boat.cfg.hull.uprightDragArea;
    t.speedKn.forEach((kn, i) => expect(uprightDragArea(boat, kn * KNOT)).toBeCloseTo(t.dragAreaM2[i]!, 12));
    const v = 4 * KNOT;
    const r = hullForces(initialState(0, v), boat, cfg.env, cfg.terms);
    expect(r.upright).toBeCloseTo(0.5 * cfg.env.rhoWater * v * v * 0.01566, 9);
    expect(r.fx).toBeCloseTo(-r.upright, 12);
  });

  it('opposes motion astern too', () => {
    expect(hullForces(initialState(0, -1), boat, cfg.env, cfg.terms).fx).toBeGreaterThan(0);
  });

  it('adds Larsson Fig 5.26 heel resistance, proportional to heel', () => {
    const tcT = boat.tc / boat.cfg.hull.draughtBoardDown;
    const bt = boat.cfg.hull.table2.bwlOverTc;
    expect(heelResistanceCoefficient(boat)).toBeCloseTo((6.747 * tcT + 2.517 * bt + 3.71 * bt * tcT) * 1e-3, 12);
    const v = 2;
    const upright = hullForces(initialState(0, v), boat, cfg.env, cfg.terms);
    expect(upright.heelResistance).toBe(0);
    const at10 = hullForces({ ...initialState(0, v), heel: 10 * DEG }, boat, cfg.env, cfg.terms);
    const at20 = hullForces({ ...initialState(0, v), heel: -20 * DEG }, boat, cfg.env, cfg.terms);
    const fn2 = (v * v) / (G * boat.lwl);
    const expected = 0.5 * cfg.env.rhoWater * v * v * boat.wettedArea * heelResistanceCoefficient(boat) * fn2 * 10 * DEG;
    expect(at10.heelResistance).toBeCloseTo(expected, 9);
    expect(at20.heelResistance).toBeCloseTo(2 * at10.heelResistance, 9);
  });

  it('resists sideways sliding and yawing through crossflow drag', () => {
    const sliding = hullForces({ ...initialState(0, 0), v: 0.5 }, boat, cfg.env, cfg.terms);
    expect(sliding.fy).toBeLessThan(0);
    const yawing = hullForces({ ...initialState(0, 0), r: 0.5 }, boat, cfg.env, cfg.terms);
    expect(yawing.yawMoment).toBeLessThan(0);
    const off = hullForces({ ...initialState(0, 0), v: 0.5 }, boat, cfg.env, { ...cfg.terms, crossflowDrag: false });
    expect(off.fy).toBe(0);
  });
});
