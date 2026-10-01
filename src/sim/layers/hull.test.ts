import { describe, expect, it } from 'vitest';
import residuary from '../../data/delft-residuary.json';
import { buildBoat } from '../boat';
import { defaultConfig } from '../config';
import { DEG, G, KNOT } from '../frames';
import { initialState } from '../state';
import { delftUpright, heelResistanceCoefficient, hullForces, tableDragArea } from './hull';

const boat = buildBoat();
const cfg = defaultConfig();
const tank = { ...cfg.models, uprightResistance: 'tank' as const };
const t2 = boat.cfg.hull.table2;

describe('L4 hull resistance', () => {
  it('tank model follows the Day Fig. 2 drag area: R = 1/2 rho V^2 * dragArea', () => {
    const t = boat.cfg.hull.uprightDragArea;
    t.speedKn.forEach((kn, i) => expect(tableDragArea(t, kn * KNOT)).toBeCloseTo(t.dragAreaM2[i]!, 12));
    const v = 4 * KNOT;
    const r = hullForces(initialState(0, v), boat, cfg.env, cfg.terms, tank);
    expect(r.upright).toBeCloseTo(0.5 * cfg.env.rhoWater * v * v * 0.01566, 9);
    expect(r.fx).toBeCloseTo(-r.upright, 12);
  });

  it('delft residuary equals Keuning & Katgert Eq. 1.7 at a tabulated Froude number', () => {
    const i = residuary.fn.indexOf(0.4);
    const form =
      residuary.a1[i]! * t2.lcbOverLwl +
      residuary.a2[i]! * t2.cp +
      residuary.a3[i]! * t2.vol23OverAw +
      residuary.a4[i]! * t2.bwlOverLwl +
      residuary.a5[i]! * t2.lcbOverLcf +
      residuary.a6[i]! * t2.bwlOverTc +
      residuary.a7[i]! * t2.cm;
    const ratio = residuary.a0[i]! + form * t2.vol13OverLwl;
    const v = 0.4 * Math.sqrt(G * boat.lwl);
    const { residuary: r } = delftUpright(boat, v, cfg.env);
    expect(r).toBeCloseTo(ratio * boat.volume * cfg.env.rhoWater * G, 9);
  });

  it('delft residuary blends to zero below Fn 0.15 and is continuous there', () => {
    const v15 = 0.15 * Math.sqrt(G * boat.lwl);
    const at = delftUpright(boat, v15, cfg.env).residuary;
    expect(delftUpright(boat, v15 * (1 - 1e-9), cfg.env).residuary).toBeCloseTo(at, 6);
    expect(delftUpright(boat, v15 / 2, cfg.env).residuary).toBeCloseTo(at / 4, 9);
    expect(delftUpright(boat, 0, cfg.env).residuary).toBe(0);
  });

  it('opposes motion astern too', () => {
    expect(hullForces(initialState(0, -1), boat, cfg.env, cfg.terms, cfg.models).fx).toBeGreaterThan(0);
  });

  it('adds Larsson Fig 5.26 heel resistance, proportional to heel', () => {
    const tcT = boat.tc / boat.cfg.hull.draughtBoardDown;
    const bt = t2.bwlOverTc;
    expect(heelResistanceCoefficient(boat)).toBeCloseTo((6.747 * tcT + 2.517 * bt + 3.71 * bt * tcT) * 1e-3, 12);
    const v = 2;
    const upright = hullForces(initialState(0, v), boat, cfg.env, cfg.terms, cfg.models);
    expect(upright.heelResistance).toBe(0);
    const at10 = hullForces({ ...initialState(0, v), heel: 10 * DEG }, boat, cfg.env, cfg.terms, cfg.models);
    const at20 = hullForces({ ...initialState(0, v), heel: -20 * DEG }, boat, cfg.env, cfg.terms, cfg.models);
    const fn2 = (v * v) / (G * boat.lwl);
    const expected = 0.5 * cfg.env.rhoWater * v * v * boat.wettedArea * heelResistanceCoefficient(boat) * fn2 * 10 * DEG;
    expect(at10.heelResistance).toBeCloseTo(expected, 9);
    expect(at20.heelResistance).toBeCloseTo(2 * at10.heelResistance, 9);
  });

  it('resists sideways sliding and yawing through crossflow drag', () => {
    const sliding = hullForces({ ...initialState(0, 0), v: 0.5 }, boat, cfg.env, cfg.terms, cfg.models);
    expect(sliding.fy).toBeLessThan(0);
    const yawing = hullForces({ ...initialState(0, 0), r: 0.5 }, boat, cfg.env, cfg.terms, cfg.models);
    expect(yawing.yawMoment).toBeLessThan(0);
    const off = hullForces({ ...initialState(0, 0), v: 0.5 }, boat, cfg.env, { ...cfg.terms, crossflowDrag: false }, cfg.models);
    expect(off.fy).toBe(0);
  });
});
